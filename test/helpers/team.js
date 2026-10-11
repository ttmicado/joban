// テスト用: node:sqlite のメモリ DB でチームアプリを動かすヘルパー
//   const t = makeTeam();
//   const admin = await t.join("監督");          // LINE ユーザーを作って参加（最初の人は管理者）
//   const res = await admin.post("/events", {...}); // → { status, body }
//   t.setNow("2026-10-18T06:00")                    // JST で時刻を固定
import { DatabaseSync } from "node:sqlite";
import { createTeamApp } from "../../src/team/app.js";
import { nodeDb } from "../../src/team/db.js";
import { features as allFeatures } from "../../src/team/features/index.js";

export function makeTeam({ features = allFeatures, env = {}, now = "2026-10-11T12:00" } = {}) {
  const db = nodeDb(new DatabaseSync(":memory:"));
  let ts = jstTs(now);
  const sent = [];
  const app = createTeamApp({
    db,
    env,
    features,
    clock: () => ts,
    log: { error: (...a) => console.error(...a), warn() {}, info() {} },
  });

  const client = (user) => {
    const call = async (method, path, body) => {
      const [p, qs] = path.split("?");
      const query = Object.fromEntries(new URLSearchParams(qs || ""));
      const res = await app.handle({ method, path: p, query, body, user });
      const isJson = (res.headers["Content-Type"] || "").includes("json");
      return { status: res.status, body: isJson ? JSON.parse(res.body) : res.body, headers: res.headers };
    };
    return {
      user,
      get: (p) => call("GET", p),
      post: (p, b) => call("POST", p, b),
      patch: (p, b) => call("PATCH", p, b),
      put: (p, b) => call("PUT", p, b),
      del: (p, b) => call("DELETE", p, b),
    };
  };

  let seq = 0;
  return {
    app,
    db,
    sent,
    anon: client(null),
    user(name = `user${++seq}`) {
      return client({ userId: `U${name}-${++seq}`, displayName: name, pictureUrl: "" });
    },
    async join(name, extra = {}) {
      const c = this.user(name);
      const res = await c.post("/join", { name, ...extra });
      if (res.status !== 200) throw new Error(`join failed: ${JSON.stringify(res.body)}`);
      c.member = res.body.member;
      return c;
    },
    setNow(s) {
      ts = jstTs(s);
    },
    cron: () => app.cron(),
  };
}

function jstTs(s) {
  const [d, t = "00:00"] = s.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return Date.UTC(y, m - 1, day, hh, mm) - 9 * 3600 * 1000;
}
