// 機能をまたいだ連携テスト（実際の機能どうしで emit → LINE 通知まで）
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { makeTeam } from "./helpers/team.js";

const ENV = { LINE_MESSAGING_TOKEN: "tok", LINE_MESSAGING_SECRET: "sec", LIFF_ID: "2000000000-abcdEFGH" };
const GROUP = "Cgroup0000000000000000000000000001";

let calls = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200 });
  };
});
afterEach(() => (globalThis.fetch = realFetch));
const pushes = () => calls.filter((c) => c.url.endsWith("/message/push")).map((c) => JSON.stringify(c.body));

async function setup() {
  const t = makeTeam({ env: ENV, now: "2026-10-11T12:00" });
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const rawBody = JSON.stringify({ events: [{ type: "join", replyToken: "r", source: { type: "group", groupId: GROUP } }] });
  await t.app.handle({
    method: "POST",
    path: "/line/webhook",
    body: JSON.parse(rawBody),
    rawBody,
    headers: { "x-line-signature": createHmac("sha256", "sec").update(rawBody).digest("base64") },
  });
  assert.equal((await admin.patch("/line/settings", { targetGroupId: GROUP })).status, 200);
  calls = [];
  return { t, admin, taro };
}

test("重要なお知らせは「重要のみ」設定でも LINE に通知され、雑談は通知されない", async () => {
  const { admin, taro } = await setup();
  assert.equal((await admin.post("/notices", { category: "important", title: "集合時間変更", body: "7:30集合です" })).status, 200);
  assert.equal(pushes().length, 1);
  assert.match(pushes()[0], /集合時間変更/);
  assert.equal((await taro.post("/notices", { category: "chat", body: "ナイスゲーム！" })).status, 200);
  assert.equal(pushes().length, 1);
});

test("予定作成・日程調整・試合確定が LINE に流れる", async () => {
  const { admin } = await setup();
  const ev = await admin.post("/events", { type: "game", title: "練習試合 vs 青葉", date: "2026-10-25", meet_time: "07:30", venue: "市民球場", opponent: "青葉" });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.match(pushes().join(), /市民球場/);

  const poll = await admin.post("/polls", { title: "11月の練習試合", options: [{ date: "2026-11-08", note: "河川敷" }, { date: "2026-11-15" }] });
  assert.equal(poll.status, 200, JSON.stringify(poll.body));
  assert.match(pushes().join(), /河川敷/);

  const eventId = ev.body.event?.id ?? ev.body.id;
  const g = await admin.post("/games", { eventId, event_id: eventId, date: "2026-10-25", opponent: "青葉" });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const gameId = g.body.game?.id ?? g.body.id;
  assert.equal((await admin.put(`/games/${gameId}/score`, { ourScore: 8, theirScore: 5 })).status, 200);
  const before = pushes().length;
  const fin = await admin.post(`/games/${gameId}/finalize`, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(pushes().length, before + 1);
  assert.match(pushes().at(-1), /青葉/);
});
