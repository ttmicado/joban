// サーバー入口（src/server.js）: Vercel の rewrite 後の URL（__path）でも正しく振り分けられること
import assert from "node:assert/strict";
import test from "node:test";
import { pgliteDb } from "../src/db.js";
import { createServer } from "../src/server.js";
import { sharedPglite } from "./helpers/team.js";

async function setup(env = {}) {
  const pg = sharedPglite();
  const schema = `srv_${Math.random().toString(36).slice(2, 8)}`;
  await pg.exec(`CREATE SCHEMA "${schema}"`);
  return createServer({ env: { ALLOW_MOCK: "true", LIFF_ID: "123-abc", ...env }, db: pgliteDb(pg, { schema }), log: { error() {} } });
}
const auth = { Authorization: "Bearer mock:k:" + encodeURIComponent("監督") };

test("rewrite 後の __path で API に届き、元のクエリも渡る", async () => {
  const s = await setup();
  const cfg = await s.fetch(new Request("https://app.example/api/handler?__path=%2Fapi%2Fconfig&path=config"));
  assert.deepEqual(await cfg.json(), { liffId: "123-abc", mock: true });

  const join = await s.fetch(
    new Request("https://app.example/api/handler?__path=%2Fapi%2Fteam%2Fjoin&path=team%2Fjoin", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "監督" }),
    }),
  );
  assert.equal(join.status, 200);
  const list = await s.fetch(new Request("https://app.example/api/handler?__path=%2Fapi%2Fteam%2Fmembers&all=1", { headers: auth }));
  assert.equal((await list.json()).members.length, 1);

  // 直接のパス（ローカル開発サーバー）でも同じ
  const me = await s.fetch(new Request("http://127.0.0.1/api/team/me", { headers: auth }));
  assert.equal((await me.json()).member.role, "admin");

  assert.equal((await s.fetch(new Request("https://app.example/api/handler?__path=%2Fapi%2Fnope"))).status, 404);
});

test("cron は CRON_SECRET が必要（未設定でも ALLOW_MOCK 以外は拒否）", async () => {
  const s = await setup({ CRON_SECRET: "sec", ALLOW_MOCK: "false" });
  assert.equal((await s.fetch(new Request("https://a/api/cron"))).status, 403);
  assert.equal((await s.fetch(new Request("https://a/api/cron", { headers: { Authorization: "Bearer bad" } }))).status, 403);
  assert.equal((await s.fetch(new Request("https://a/api/cron", { headers: { Authorization: "Bearer sec" } }))).status, 200);
  const s2 = await setup({ ALLOW_MOCK: "false" });
  assert.equal((await s2.fetch(new Request("https://a/api/cron"))).status, 403);
});

test("ガラポン API と本番のモックログイン拒否", async () => {
  const s = await setup();
  const b = await s.fetch(new Request("https://a/api/handler?__path=%2Fapi%2Fgarapon%2Fboard"));
  assert.equal((await b.json()).stats.total, 19);
  const prod = await setup({ ALLOW_MOCK: "false" });
  assert.equal((await prod.fetch(new Request("https://a/api/team/me", { headers: auth }))).status, 401);
});
