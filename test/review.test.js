// 統合後のレビューで見つかった不具合の再現テスト
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach, beforeEach } from "node:test";
import { makeTeam } from "./helpers/team.js";
import { HttpError, authenticate, safeEqualStr } from "../src/auth.js";
import { readJson } from "../src/http.js";
import { nodeDb } from "../src/team/db.js";
import { isDate } from "../src/team/time.js";

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

// ---------------------------------------------------------------- worker / auth

test("本文なしの DELETE は null として読み、不正な JSON だけ 400", async () => {
  assert.equal(await readJson(new Request("http://x/api/team/venues/1", { method: "DELETE" })), null);
  assert.equal(await readJson(new Request("http://x/", { method: "POST", body: "  " })), null);
  assert.deepEqual(await readJson(new Request("http://x/", { method: "POST", body: '{"a":1}' })), { a: 1 });
  await assert.rejects(
    () => readJson(new Request("http://x/", { method: "POST", body: "{bad" })),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test("モックトークンの名前が壊れていても 500 にせず 401", async () => {
  const req = new Request("http://x/", { headers: { Authorization: "Bearer mock:a:%E0" } });
  await assert.rejects(() => authenticate(req, { ALLOW_MOCK: "true" }), (e) => e instanceof HttpError && e.status === 401);
  const ok = new Request("http://x/", { headers: { Authorization: "Bearer mock:a:%E5%A4%AA%E9%83%8E" } });
  assert.equal((await authenticate(ok, { ALLOW_MOCK: "true" })).displayName, "太郎");
});

test("管理キーの比較", () => {
  assert.equal(safeEqualStr("abc", "abc"), true);
  assert.equal(safeEqualStr("abc", "abd"), false);
  assert.equal(safeEqualStr("", ""), false);
  assert.equal(safeEqualStr("ab", "abc"), false);
});

// ---------------------------------------------------------------- コア

test("URL の不正なエスケープは 500 ではなく 400", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  assert.equal((await admin.get("/events/%E0")).status, 400);
});

test("本文が配列・文字列でも 500 にならず検証エラー", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  assert.equal((await admin.post("/venues", ["x"])).status, 400);
  assert.equal((await admin.post("/games", "abc")).status, 400);
});

test("SQL パラメータの NaN・Infinity は NULL に正規化（DO の sql.exec は受け付けない）", () => {
  const db = nodeDb(new DatabaseSync(":memory:"));
  assert.equal(db.one("SELECT ? AS x", NaN).x, null);
  assert.equal(db.one("SELECT ? AS x", Infinity).x, null);
  assert.equal(db.one("SELECT ? AS x", 3).x, 3);
});

test("実在しない日付は受け付けない", async () => {
  assert.equal(isDate("2026-02-28"), true);
  assert.equal(isDate("2028-02-29"), true);
  assert.equal(isDate("2026-02-30"), false);
  assert.equal(isDate("2026-13-01"), false);
  assert.equal(isDate("0000-00-00"), false);
  const t = makeTeam();
  const admin = await t.join("監督");
  assert.equal((await admin.post("/events", { title: "練習", date: "2026-02-30" })).status, 400);
  assert.equal((await admin.post("/games", { date: "2026-13-01", opponent: "青葉" })).status, 400);
});

test("文字列・数値の項目にオブジェクトや配列を渡すと 400", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  assert.equal((await admin.post("/venues", { name: { a: 1 } })).status, 400);
  const ev = (await admin.post("/events", { title: "練習", date: "2026-10-20" })).body.event;
  // 配列 [太郎のid] が Number() で太郎の id になってしまわないこと
  assert.equal((await admin.put(`/events/${ev.id}/rsvp`, { member_id: [taro.member.id], status: "yes" })).status, 400);
});

test("守備位置の配列が長すぎると 400", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const res = await admin.patch("/me", { positions: Array(1000).fill("投") });
  assert.equal(res.status, 400);
  assert.equal((await admin.patch("/me", { positions: ["投", "一"] })).status, 200);
});

// ---------------------------------------------------------------- データ整合

test("予定を削除すると起床報告も消える", async () => {
  const t = makeTeam({ now: "2026-10-18T06:00" });
  const admin = await t.join("監督");
  const ev = (await admin.post("/events", { type: "practice", title: "朝練", date: "2026-10-18", meet_time: "08:00" })).body.event;
  assert.equal((await admin.post(`/wakeups/${ev.id}`, { stage: "woke" })).status, 200);
  assert.equal(t.db.one("SELECT COUNT(*) AS n FROM wakeups").n, 1);
  assert.equal((await admin.del(`/events/${ev.id}`)).status, 200);
  assert.equal(t.db.one("SELECT COUNT(*) AS n FROM wakeups").n, 0);
});

test("予定から試合を作るとき、長いタイトルでも対戦相手の上限で失敗しない", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("監督");
  const title = "あ".repeat(60);
  const ev = (await admin.post("/events", { type: "game", title, date: "2026-10-11" })).body.event;
  const g = await admin.post("/games", { eventId: ev.id });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.game.opponent.length, 40);
});

test("dev-seed の作り直しで打席ごとの結果も消える", async () => {
  const t = makeTeam({ env: { ALLOW_MOCK: "true" } });
  const admin = await t.join("監督");
  assert.equal((await admin.post("/stats/dev-seed", { games: 1 })).status, 200);
  const gid = t.db.one("SELECT id FROM games WHERE memo = '[dev-seed]' LIMIT 1").id;
  t.db.run("INSERT INTO games_at_bats(game_id, member_id, seq, result) VALUES(?, 1, 1, '1B')", gid);
  assert.equal((await admin.post("/stats/dev-seed", { games: 1 })).status, 200);
  assert.equal(t.db.one("SELECT COUNT(*) AS n FROM games_at_bats WHERE game_id = ?", gid).n, 0);
});

// ---------------------------------------------------------------- LINE cron

const ENV = { LINE_MESSAGING_TOKEN: "tok", LINE_MESSAGING_SECRET: "sec", LIFF_ID: "2000000000-abcdEFGH" };
const GROUP = "Cgroup0000000000000000000000000001";

async function lineSetup(now) {
  const t = makeTeam({ env: ENV, now });
  const admin = await t.join("監督");
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
  return { t, admin };
}

test("成績入力リマインド: 控え・投手成績入力済み・退団者は未入力に含めない", async () => {
  const { t, admin } = await lineSetup("2026-10-12T12:00");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  const saburo = await t.join("三郎");
  const shiro = await t.join("四郎");
  const gid = t.db.run(
    "INSERT INTO games(season, date, opponent, status, created_at, updated_at) VALUES(2026, '2026-10-11', '川口', 'draft', 0, 0)",
  ).lastId;
  const bat = (id, pos) => t.db.run("INSERT INTO batting(game_id, member_id, position, pa, updated_at) VALUES(?, ?, ?, 0, 0)", gid, id, pos);
  bat(taro.member.id, "遊"); // 未入力 → 名前が出る
  bat(jiro.member.id, "控え"); // 控え → 出ない
  bat(saburo.member.id, "投"); // 投手成績あり → 出ない
  t.db.run("INSERT INTO pitching(game_id, member_id, outs, updated_at) VALUES(?, ?, 21, 0)", gid, saburo.member.id);
  bat(shiro.member.id, "右"); // 退団 → 出ない
  assert.equal((await admin.patch(`/members/${shiro.member.id}`, { active: false })).status, 200);

  calls = [];
  t.setNow("2026-10-12T20:00");
  await t.cron();
  const remind = pushes().filter((p) => /成績入力のお願い/.test(p));
  assert.equal(remind.length, 1);
  assert.match(remind[0], /太郎/);
  assert.doesNotMatch(remind[0], /次郎|三郎|四郎/);
});

test("起床チェック: 集合 0:30 の予定は前日 23:00 に送る", async () => {
  const { t, admin } = await lineSetup("2026-10-17T12:00");
  const taro = await t.join("太郎");
  const ev = (await admin.post("/events", { type: "practice", title: "ナイター明け朝練", date: "2026-10-18", meet_time: "00:30" })).body.event;
  assert.equal((await taro.put(`/events/${ev.id}/rsvp`, { status: "yes" })).status, 200);
  calls = [];
  t.setNow("2026-10-17T22:45");
  await t.cron();
  assert.equal(pushes().filter((p) => /起きてますか/.test(p)).length, 0);
  t.setNow("2026-10-17T23:00");
  await t.cron();
  const wake = pushes().filter((p) => /起きてますか/.test(p));
  assert.equal(wake.length, 1);
  assert.match(wake[0], /太郎/);
});
