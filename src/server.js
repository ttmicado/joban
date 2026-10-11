// HTTP の入口（Web 標準の Request → Response）。Vercel の関数（api/handler.js）と
// ローカル開発サーバー（scripts/dev.js）の両方から使う。
//
//   /api/config            LIFF ID など
//   /api/team/*            チームアプリ（src/team）
//   /api/garapon/*         ガラポン抽選会（src/garapon）
//   /api/line/webhook      LINE 公式アカウントの Webhook
//   /api/cron              定期実行（Vercel Cron から15分ごと。CRON_SECRET で保護）
//   /ics/<token>.ics       カレンダー購読
import { HttpError, authenticate, checkAdmin, safeEqualStr } from "./auth.js";
import { Lottery } from "./garapon/store.js";
import { readJson } from "./http.js";
import { createTeamApp } from "./team/app.js";
import { features } from "./team/features/index.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export function createServer({ env, db, log = console }) {
  const teamApp = createTeamApp({ db, env, features, log });
  const lottery = new Lottery(db);

  async function fetch(request) {
    const url = new URL(request.url);
    // Vercel では vercel.json の rewrite で元のパスが __path に入ってくる
    const path = url.searchParams.get("__path") || url.pathname;
    if (url.searchParams.has("__path")) {
      url.searchParams.delete("__path");
      // rewrite の名前付きパラメータ（path / file）も付いてくるので取り除く
      for (const k of ["path", "file"]) {
        const v = url.searchParams.get(k);
        if (v !== null && path.endsWith(v)) url.searchParams.delete(k);
      }
    }
    try {
      if (path === "/api/config") {
        return json({ liffId: env.LIFF_ID || "", mock: env.ALLOW_MOCK === "true" });
      }
      if (path.startsWith("/api/garapon/")) return await garapon(request, path.slice("/api/garapon".length));
      if (path.startsWith("/api/team/")) return await team(request, url, path.slice("/api/team".length));
      if (path === "/api/line/webhook" && request.method === "POST") return await lineWebhook(request, url);
      if (path === "/api/cron") return await cron(request);
      const ics = /^\/ics\/([\w-]+)\.ics$/.exec(path);
      if (ics) return await teamRaw({ method: "GET", path: `/ics/${ics[1]}`, headers: origin(request, url) });
      return json({ error: "not_found", message: "Not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
      log.error(err);
      return json({ error: "server", message: "サーバーエラーが発生しました" }, 500);
    }
  }

  // リバースプロキシ越しでも正しい公開 URL を使う
  function origin(request, url) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
    const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    return { host, origin: `${proto}://${host}` };
  }

  // --- チームアプリ --------------------------------------------------------

  async function team(request, url, path) {
    // Authorization ヘッダーがあればログインユーザーとして扱う（public な API は無くても可）
    const user = request.headers.get("Authorization") ? await authenticate(request, env) : null;
    // DELETE など本文なしのリクエストは body = null
    const body = request.method !== "GET" && request.method !== "HEAD" ? await readJson(request) : null;
    return teamRaw({
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      user,
      headers: origin(request, url),
    });
  }

  async function lineWebhook(request, url) {
    const rawBody = await request.text();
    let body = null;
    try {
      body = JSON.parse(rawBody);
    } catch {}
    return teamRaw({
      method: "POST",
      path: "/line/webhook",
      body,
      rawBody,
      headers: { "x-line-signature": request.headers.get("x-line-signature") || "", ...origin(request, url) },
    });
  }

  async function teamRaw(req) {
    const res = await teamApp.handle(req);
    return new Response(res.body, { status: res.status, headers: { "Cache-Control": "no-store", ...res.headers } });
  }

  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けて呼ぶ
  async function cron(request) {
    const auth = request.headers.get("Authorization") || "";
    const ok = env.CRON_SECRET ? safeEqualStr(auth, `Bearer ${env.CRON_SECRET}`) : env.ALLOW_MOCK === "true";
    if (!ok) return json({ error: "forbidden", message: "Forbidden" }, 403);
    await teamApp.cron();
    return json({ ok: true });
  }

  // --- ガラポン -------------------------------------------------------------

  async function garapon(request, path) {
    const asResult = (r, profile) => (r.error ? json(r, 409) : json(profile ? { profile, ...r } : r));
    switch (`${request.method} ${path}`) {
      case "GET /board":
        return json(await lottery.view(null));
      case "GET /me": {
        const p = await authenticate(request, env);
        return json({ profile: p, ...(await lottery.view(p.userId)) });
      }
      case "POST /entry": {
        const p = await authenticate(request, env);
        return asResult(await lottery.enter(p), p);
      }
      case "POST /spin": {
        const p = await authenticate(request, env);
        return asResult(await lottery.spin(p.userId), p);
      }
      case "GET /admin/state":
        checkAdmin(request, env);
        return json(await lottery.adminState());
      case "POST /admin/config": {
        checkAdmin(request, env);
        const patch = await readJson(request);
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          throw new HttpError(400, "bad_json", "リクエストの形式が不正です");
        }
        return asResult(await lottery.adminConfig(patch));
      }
      case "POST /admin/reset": {
        checkAdmin(request, env);
        const body = await readJson(request).catch(() => null);
        return json(await lottery.adminReset(Boolean(body?.keepEntries)));
      }
      default:
        return json({ error: "not_found", message: "Not found" }, 404);
    }
  }

  return { fetch, teamApp, lottery };
}
