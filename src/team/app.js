// チームアプリのコア。ルーティング・認可・マイグレーション・イベント配信・cron を担当する。
// サーバー（src/server.js）とテスト（test/helpers/team.js）の両方から使う。DB は Postgres（src/db.js）。
//
// 機能モジュール（src/team/features/*.js）の形:
//   export default {
//     name: "schedule",
//     migrations: [{ id: "schedule-001", sql: "CREATE TABLE ..." }],
//     routes: [
//       ["GET", "/events", handler, { auth: "member" }],   // auth: public | user | member | admin（既定 member）
//       ["POST", "/events/:id/rsvp", handler],
//     ],
//     on: { "event.created": async (c, payload) => {} },   // 他機能が emit したイベントを購読
//     cron: async (c) => {},                               // 15分ごとに呼ばれる（c.now で時刻判定）
//   };
//
// handler(c) の c:
//   db（await 必須。このリクエスト専用のトランザクション）, env, now（JST: {ts,date,time,year,weekday}）,
//   params, query, body, rawBody, headers, user（LINE プロフィール or null）, member（参加済みメンバー or null）,
//   isAdmin, settings（チーム設定）, await saveSettings(patch), emit(name, payload), await once(key, fn),
//   requireAdminOrSelf(memberId)
// handler は JSON にできる値を返す。JSON 以外は raw(body, { status, headers }) を返す。
//
// 1リクエスト = 1トランザクション。GET 以外のリクエストと cron はチーム全体の排他ロックを取り、
// 直列に実行される（以前の Durable Object と同じく、同時更新の競合を気にしなくてよい）。
// ハンドラーが例外を投げたらそのリクエストの変更はすべてロールバックされる。

import { ApiError, badRequest, forbidden, notFound } from "./errors.js";
import { DEFAULT_SETTINGS, coreMigrations } from "./schema.js";
import { jst } from "./time.js";

export const raw = (body, { status = 200, headers = {} } = {}) => ({ __raw: true, status, headers, body });

const LOCK_KEY = "team";

export function createTeamApp({ db, env = {}, features = [], clock = () => Date.now(), log = console }) {
  const migrations = [...coreMigrations, ...features.flatMap((f) => f.migrations || [])];
  let ready = null;
  // マイグレーションは最初のリクエスト時に1回だけ（失敗したら次のリクエストで再試行）
  const ensureReady = () => {
    ready ??= migrate(db, migrations).catch((err) => {
      ready = null;
      throw err;
    });
    return ready;
  };

  const routes = [];
  for (const f of features) {
    for (const [method, path, handler, opts = {}] of f.routes || []) {
      routes.push({ method, path, handler, auth: opts.auth || "member", feature: f.name, ...compile(path) });
    }
  }

  const settings = {
    async get(db) {
      const out = { ...DEFAULT_SETTINGS };
      for (const row of await db.all("SELECT key, value FROM settings")) out[row.key] = JSON.parse(row.value);
      if (!out.season) out.season = jst(clock()).year;
      if (!out.icsToken) {
        out.icsToken = crypto.randomUUID().replace(/-/g, "");
        // 同時に生成されても最初の値を採用する
        await db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING", "icsToken", JSON.stringify(out.icsToken));
        const row = await db.one("SELECT value FROM settings WHERE key = 'icsToken'");
        out.icsToken = JSON.parse(row.value);
      }
      return out;
    },
    async set(db, patch) {
      for (const [k, val] of Object.entries(patch)) {
        await db.run(
          "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          k,
          JSON.stringify(val),
        );
      }
    },
  };

  async function baseContext(db) {
    const c = {
      db,
      env,
      now: jst(clock()),
      settings: await settings.get(db),
      async saveSettings(patch) {
        await settings.set(db, patch);
        c.settings = await settings.get(db);
      },
      pending: [],
      emit(name, payload) {
        c.pending.push([name, payload]);
      },
      // key ごとに1度だけ fn を実行（通知の二重送信防止）。実行したら true
      async once(key, fn) {
        const { changes } = await db.run("INSERT INTO sent_log(key, at) VALUES(?, ?) ON CONFLICT(key) DO NOTHING", key, c.now.ts);
        if (!changes) return false;
        await fn();
        return true;
      },
      log,
    };
    return c;
  }

  async function flush(c) {
    // handler 内で emit されたイベントを、応答確定後に購読者へ配る（購読側の失敗で本処理を失敗させない）
    while (c.pending.length) {
      const [name, payload] = c.pending.shift();
      for (const f of features) {
        const fn = f.on?.[name];
        if (!fn) continue;
        try {
          await fn(c, payload);
        } catch (err) {
          log.error(`[${f.name}] on ${name} failed`, err);
        }
      }
    }
  }

  return {
    settings,

    // req: { method, path, query, body, user, rawBody?, headers? }
    async handle(req) {
      try {
        const route = match(routes, req.method, req.path);
        if (!route) throw notFound("APIが見つかりません");
        await ensureReady();
        return await db.tx(async (tx) => {
          if (req.method !== "GET") await tx.lock(LOCK_KEY);
          return run(tx, route, req);
        });
      } catch (err) {
        return errorResponse(err);
      }
    },

    async cron() {
      await ensureReady();
      await db.tx(async (tx) => {
        await tx.lock(LOCK_KEY);
        const c = await baseContext(tx);
        for (const f of features) {
          if (!f.cron) continue;
          try {
            await f.cron(c);
          } catch (err) {
            log.error(`[${f.name}] cron failed`, err);
          }
        }
        await flush(c);
      });
    },

    // テスト・開発用: マイグレーション済みの DB を直接触る
    async ready() {
      await ensureReady();
      return db;
    },
  };

  async function run(db, route, req) {
    const c = await baseContext(db);
    c.params = route.params;
    c.query = req.query || {};
    // 本文はオブジェクトだけ受け付ける（配列・文字列・数値などは空として扱う）
    c.body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    c.rawBody = req.rawBody ?? null; // 署名検証が必要な webhook 用
    c.headers = req.headers || {};
    c.user = req.user || null;
    c.member = c.user
      ? await db.one("SELECT * FROM members WHERE line_user_id = ? AND active = 1", c.user.userId)
      : null;
    c.isAdmin = c.member?.role === "admin";
    c.requireAdminOrSelf = (memberId) => {
      if (!c.isAdmin && Number(memberId) !== c.member?.id) throw forbidden("本人か管理者だけが編集できます");
    };

    const { auth } = route.route;
    if (auth !== "public" && !c.user) throw new ApiError(401, "login_required", "LINEログインが必要です");
    if ((auth === "member" || auth === "admin") && !c.member) {
      throw new ApiError(403, "not_member", "先にチームに参加してください");
    }
    if (auth === "admin" && !c.isAdmin) throw forbidden("管理者だけが操作できます");

    const result = await route.route.handler(c);
    await flush(c);
    if (result && result.__raw) return { status: result.status, headers: result.headers, body: result.body };
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(result ?? { ok: true }) };
  }

  function errorResponse(err) {
    if (err instanceof ApiError) {
      return { status: err.status, headers: JSON_HEADERS, body: JSON.stringify({ error: err.code, message: err.message }) };
    }
    log.error(err);
    return { status: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: "server", message: "サーバーエラーが発生しました" }) };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

async function migrate(db, migrations) {
  await db.tx(async (tx) => {
    // 複数のサーバーインスタンスが同時に起動しても1回だけ実行されるようにロック
    await tx.lock("migrate");
    await tx.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, at BIGINT NOT NULL)");
    const done = new Set((await tx.all("SELECT id FROM _migrations")).map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await tx.exec(m.sql);
      await tx.run("INSERT INTO _migrations(id, at) VALUES(?, ?)", m.id, Date.now());
    }
  });
}

function compile(path) {
  const keys = [];
  const re = new RegExp(
    "^" + path.replace(/\/:(\w+)/g, (_, k) => (keys.push(k), "/([^/]+)")) + "/?$",
  );
  return { re, keys };
}

function match(routes, method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        throw badRequest("URLの形式が不正です");
      }
    });
    return { route: r, params };
  }
  return null;
}
