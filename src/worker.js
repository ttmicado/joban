import { HttpError, authenticate, checkAdmin } from "./auth.js";

export { Lottery } from "./garapon/do.js";
export { Team } from "./team/do.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const teamStub = (env) => env.TEAM.get(env.TEAM.idFromName("team"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/config") {
        return json({ liffId: env.LIFF_ID || "", mock: env.ALLOW_MOCK === "true" });
      }
      if (path.startsWith("/api/garapon/")) return await garapon(request, env, path.slice("/api/garapon".length));
      if (path.startsWith("/api/team/")) return await team(request, env, path.slice("/api/team".length));
      if (path === "/api/line/webhook" && request.method === "POST") return await lineWebhook(request, env);
      // カレンダー購読: /ics/<token>.ics
      const ics = /^\/ics\/([\w-]+)\.ics$/.exec(path);
      if (ics) return await teamRaw(env, { method: "GET", path: `/ics/${ics[1]}`, headers: { host: url.host, origin: url.origin } });
      if (path.startsWith("/api/")) return json({ error: "not_found", message: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
      console.error(err);
      return json({ error: "server", message: "サーバーエラーが発生しました" }, 500);
    }
  },

  // 15分ごとの定期実行（リマインド通知など）
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(teamStub(env).cron());
  },
};

// --- チームアプリ ----------------------------------------------------------

async function team(request, env, path) {
  // Authorization ヘッダーがあればログインユーザーとして扱う（public な API は無くても可）
  const user = request.headers.get("Authorization") ? await authenticate(request, env) : null;
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.json().catch(() => {
      throw new HttpError(400, "bad_json", "リクエストの形式が不正です");
    });
  }
  const url = new URL(request.url);
  return teamRaw(env, {
    method: request.method,
    path,
    query: Object.fromEntries(url.searchParams),
    body,
    user,
    headers: { host: url.host, origin: url.origin },
  });
}

async function lineWebhook(request, env) {
  const rawBody = await request.text();
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {}
  return teamRaw(env, {
    method: "POST",
    path: "/line/webhook",
    body,
    rawBody,
    headers: {
      "x-line-signature": request.headers.get("x-line-signature") || "",
      host: new URL(request.url).host,
      origin: new URL(request.url).origin,
    },
  });
}

async function teamRaw(env, req) {
  const res = await teamStub(env).handle(req);
  return new Response(res.body, {
    status: res.status,
    headers: { "Cache-Control": "no-store", ...res.headers },
  });
}

// --- ガラポン ---------------------------------------------------------------

async function garapon(request, env, path) {
  const lottery = env.LOTTERY.get(env.LOTTERY.idFromName("main"));
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
    case "POST /admin/config":
      checkAdmin(request, env);
      return asResult(await lottery.adminConfig(await request.json()));
    case "POST /admin/reset": {
      checkAdmin(request, env);
      const body = await request.json().catch(() => ({}));
      return json(await lottery.adminReset(Boolean(body.keepEntries)));
    }
    default:
      return json({ error: "not_found", message: "Not found" }, 404);
  }
}
