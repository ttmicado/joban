import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";
import { features as allFeatures } from "../src/team/features/index.js";

async function setup(opts = {}) {
  const t = makeTeam({ now: "2026-10-18T18:00", ...opts });
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  return { t, admin, taro, jiro };
}

const mkGame = async (c, body = {}) => {
  const res = await c.post("/games", { date: "2026-10-18", opponent: "川口クラブ", kind: "league", ...body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.game;
};

function addEvent(t, { date = "2026-10-18", opponent = "川口クラブ", type = "game", venue = "荒川河川敷A" } = {}) {
  const { lastId } = t.db.run(
    "INSERT INTO events(type, title, date, venue, opponent, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 0, 0)",
    type,
    `練習試合 vs ${opponent}`,
    date,
    venue,
    opponent,
  );
  return lastId;
}

test("試合の作成は管理者だけ・season は日付の年・イニングは設定値", async () => {
  const { admin, taro } = await setup();
  assert.equal((await taro.post("/games", { date: "2026-10-18", opponent: "A" })).status, 403);
  assert.equal((await admin.post("/games", { date: "2026-10-18" })).status, 400);
  const g = await mkGame(admin, { date: "2025-05-03" });
  assert.equal(g.season, 2025);
  assert.equal(g.innings, 7);
  assert.equal(g.status, "draft");
  assert.equal(g.bat_first, 1);
  const g2 = await mkGame(admin, { batFirst: false, innings: 9 });
  assert.equal(g2.bat_first, 0);
  assert.equal(g2.innings, 9);
  const list = await taro.get("/games?season=2025");
  assert.equal(list.body.games.length, 1);
  assert.ok(list.body.seasons.includes(2025) && list.body.seasons.includes(2026));
});

test("予定から作成: 日付・相手・球場を引き継ぎ、候補から消える・二重作成は不可", async () => {
  const { t, admin, taro } = await setup();
  const evId = addEvent(t);
  addEvent(t, { type: "practice" });
  assert.equal((await taro.get("/games/candidates")).status, 403);
  const cand = await admin.get("/games/candidates");
  assert.deepEqual(cand.body.events.map((e) => e.id), [evId]);
  const g = await mkGame(admin, { eventId: evId, date: undefined, opponent: undefined, kind: "friendly" });
  assert.equal(g.event_id, evId);
  assert.equal(g.opponent, "川口クラブ");
  assert.equal(g.venue, "荒川河川敷A");
  assert.equal(g.date, "2026-10-18");
  assert.equal((await admin.get("/games/candidates")).body.events.length, 0);
  assert.equal((await admin.post("/games", { eventId: evId })).status, 409);
});

test("スコア保存: イニングの合計が得点になる・合計だけも可・シーズン成績", async () => {
  const { admin, taro } = await setup();
  const g = await mkGame(admin);
  assert.equal((await taro.put(`/games/${g.id}/score`, { ourScore: 1, theirScore: 0 })).status, 403);
  const res = await admin.put(`/games/${g.id}/score`, { lineUs: [0, 2, 1, 0, 3, 0, 2], lineThem: [1, 0, 0, 2, 0, 2, null] });
  assert.equal(res.status, 200);
  assert.equal(res.body.game.our_score, 8);
  assert.equal(res.body.game.their_score, 5);
  assert.deepEqual(res.body.game.line_them, [1, 0, 0, 2, 0, 2]);
  assert.equal(res.body.game.result, "win");
  const g2 = await mkGame(admin, { opponent: "B" });
  const r2 = await admin.put(`/games/${g2.id}/score`, { ourScore: 3, theirScore: 3 });
  assert.equal(r2.body.game.result, "draw");
  assert.equal(r2.body.game.line_us, null);
  assert.equal((await admin.put(`/games/${g2.id}/score`, { lineUs: [-1] })).status, 400);
  const list = await taro.get("/games");
  assert.deepEqual(
    { w: list.body.summary.win, l: list.body.summary.lose, d: list.body.summary.draw, r: list.body.summary.runs, a: list.body.summary.allowed },
    { w: 1, l: 0, d: 1, r: 11, a: 8 },
  );
  assert.equal(list.body.summary.winPct, 1);
});

test("スタメン保存: 打順・守備を記録し、入力済みの成績は保持される", async () => {
  const { admin, taro, jiro } = await setup();
  const g = await mkGame(admin);
  await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["HR", "SO"], rbi: 2, r: 1 });
  const lineup = [
    { memberId: taro.member.id, orderNo: 1, position: "遊" },
    { memberId: jiro.member.id, orderNo: 2, position: "投" },
    { memberId: admin.member.id, orderNo: null, position: "控え" },
  ];
  assert.equal((await taro.put(`/games/${g.id}/lineup`, { lineup })).status, 403);
  assert.equal(
    (await admin.put(`/games/${g.id}/lineup`, { lineup: [lineup[0], { ...lineup[1], orderNo: 1 }] })).status,
    400,
  );
  assert.equal((await admin.put(`/games/${g.id}/lineup`, { lineup: [{ ...lineup[0], position: "X" }] })).status, 400);
  const res = await admin.put(`/games/${g.id}/lineup`, { lineup });
  assert.equal(res.status, 200);
  assert.equal(res.body.lineup.length, 3);
  const d = (await taro.get(`/games/${g.id}`)).body;
  const tr = d.batting.find((b) => b.member_id === taro.member.id);
  assert.equal(tr.order_no, 1);
  assert.equal(tr.position, "遊");
  assert.equal(tr.hr, 1);
  assert.equal(tr.rbi, 2);
  assert.equal(tr.member.name, "太郎");
  assert.equal(tr.member.line_user_id, undefined);
  // 次郎を外すと成績の無い行は消える。太郎を外しても成績は残る
  await admin.put(`/games/${g.id}/lineup`, { lineup: [lineup[2]] });
  const d2 = (await taro.get(`/games/${g.id}`)).body;
  assert.equal(d2.batting.some((b) => b.member_id === jiro.member.id), false);
  const tr2 = d2.batting.find((b) => b.member_id === taro.member.id);
  assert.equal(tr2.order_no, null);
  assert.equal(tr2.hr, 1);
});

test("成績入力: 本人は可・他人は不可・管理者は代理入力できる。打席結果から自動集計", async () => {
  const { admin, taro, jiro } = await setup();
  const g = await mkGame(admin);
  const res = await taro.put(`/games/${g.id}/batting/${taro.member.id}`, {
    atBats: ["1B", "2B", "BB", "SO", "SF", "HR"],
    rbi: 3,
    r: 2,
    sb: 1,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body.batting;
  assert.deepEqual(
    [b.pa, b.ab, b.h, b.d2, b.d3, b.hr, b.bb, b.so, b.sf, b.rbi, b.r, b.sb],
    [6, 4, 3, 1, 0, 1, 1, 1, 1, 3, 2, 1],
  );
  const rec = await taro.get(`/games/${g.id}/batting/${taro.member.id}`);
  assert.deepEqual(rec.body.atBats, ["1B", "2B", "BB", "SO", "SF", "HR"]);
  assert.equal(rec.body.canEdit, true);

  assert.equal((await taro.put(`/games/${g.id}/batting/${jiro.member.id}`, { atBats: ["1B"] })).status, 403);
  assert.equal((await taro.put(`/games/${g.id}/pitching/${jiro.member.id}`, { outs: 3 })).status, 403);
  assert.equal((await taro.get(`/games/${g.id}/batting/${jiro.member.id}`)).body.canEdit, false);
  assert.equal((await admin.put(`/games/${g.id}/batting/${jiro.member.id}`, { pa: 3, ab: 3, h: 1 })).status, 200);
  assert.equal((await admin.put(`/games/${g.id}/batting/${jiro.member.id}`, { atBats: ["XX"] })).status, 400);

  // 数値モードで保存すると打席結果の並びは消える
  await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { pa: 4, ab: 4, h: 2 });
  assert.deepEqual((await taro.get(`/games/${g.id}/batting/${taro.member.id}`)).body.atBats, []);

  const p = await jiro.put(`/games/${g.id}/pitching/${jiro.member.id}`, {
    outs: 17, bf: 24, pitches: 98, h: 5, hr: 1, so: 6, bb: 2, r: 3, er: 2, decision: "W",
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.pitching.outs, 17);
  assert.equal(p.body.pitching.order_no, 1);
  const p2 = await admin.put(`/games/${g.id}/pitching/${taro.member.id}`, { outs: 4, decision: "W" });
  assert.equal(p2.status, 400);
  assert.match(p2.body.message, /次郎/);
  assert.equal((await admin.put(`/games/${g.id}/pitching/${taro.member.id}`, { outs: 4, decision: "S" })).body.pitching.order_no, 2);
  assert.equal((await jiro.del(`/games/${g.id}/pitching/${taro.member.id}`)).status, 403);
  assert.equal((await taro.del(`/games/${g.id}/pitching/${taro.member.id}`)).status, 200);
});

test("矛盾チェック: 打撃・投手の不整合はエラー", async () => {
  const { admin, taro } = await setup();
  const g = await mkGame(admin);
  const url = `/games/${g.id}/batting/${taro.member.id}`;
  let r = await taro.put(url, { pa: 3, ab: 3, h: 4 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "inconsistent");
  assert.match(r.body.message, /安打が打数/);
  assert.equal((await taro.put(url, { pa: 2, ab: 3 })).status, 400);
  assert.equal((await taro.put(url, { pa: 3, ab: 3, h: 1, hr: 2 })).status, 400);
  assert.equal((await taro.put(url, { pa: -1 })).status, 400);
  const purl = `/games/${g.id}/pitching/${taro.member.id}`;
  r = await taro.put(purl, { outs: 6, r: 2, er: 3 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /自責点/);
  assert.match((await taro.put(purl, { outs: 6, h: 1, hr: 2 })).body.message, /被本塁打/);
  assert.equal((await taro.put(purl, { outs: 6, bf: 5, h: 3, so: 3 })).status, 400);
  assert.equal((await taro.put(purl, { outs: 6, decision: "X" })).status, 400);
});

test("確定: game.finalized を emit・確定後は本人も編集不可（管理者は可）・取り消しで再編集", async () => {
  const got = [];
  const spy = { name: "spy", on: { "game.finalized": (c, payload) => got.push(payload) } };
  const t = makeTeam({ now: "2026-10-18T18:00", features: [...allFeatures, spy] });
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const g = await mkGame(admin);
  assert.equal((await admin.post(`/games/${g.id}/finalize`, {})).status, 400); // スコア未入力
  await admin.put(`/games/${g.id}/score`, { ourScore: 5, theirScore: 2 });
  assert.equal((await taro.post(`/games/${g.id}/finalize`, {})).status, 403);
  const fin = await admin.post(`/games/${g.id}/finalize`, { mvpMemberId: taro.member.id });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.game.status, "final");
  assert.equal(got.length, 1);
  assert.equal(got[0].game.id, g.id);
  assert.equal(got[0].game.status, "final");
  assert.equal(got[0].game.mvp_member_id, taro.member.id);
  assert.equal(typeof got[0].game.line_us === "string" || got[0].game.line_us === null, true);
  // 2回目は emit しない
  await admin.post(`/games/${g.id}/finalize`, {});
  assert.equal(got.length, 1);
  assert.equal((await taro.get(`/games/${g.id}`)).body.mvp.name, "太郎");

  assert.equal((await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["1B"] })).status, 403);
  assert.equal((await admin.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["1B"] })).status, 200);
  assert.equal((await taro.post(`/games/${g.id}/reopen`)).status, 403);
  assert.equal((await admin.post(`/games/${g.id}/reopen`)).body.game.status, "draft");
  assert.equal((await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["2B"] })).status, 200);
  await admin.post(`/games/${g.id}/finalize`, {});
  assert.equal(got.length, 2);
});

test("pending: スタメンに入っていて未入力の試合・スタメン未登録なら出席者が対象", async () => {
  const { t, admin, taro, jiro } = await setup();
  const evId = addEvent(t);
  t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, 'yes', 0)", evId, taro.member.id);
  t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, 'no', 0)", evId, jiro.member.id);
  const g = await mkGame(admin, { eventId: evId });
  const future = await mkGame(admin, { date: "2026-10-25", opponent: "未来" });
  await admin.put(`/games/${future.id}/lineup`, { lineup: [{ memberId: taro.member.id, orderNo: 1, position: "中" }] });

  assert.deepEqual((await taro.get("/games/pending")).body.games.map((x) => x.id), [g.id]);
  assert.deepEqual((await jiro.get("/games/pending")).body.games, []);
  let d = (await admin.get(`/games/${g.id}`)).body;
  assert.deepEqual(d.pending.map((m) => m.name), ["太郎"]);

  // スタメン登録後はスタメンが対象
  await admin.put(`/games/${g.id}/lineup`, { lineup: [{ memberId: jiro.member.id, orderNo: 1, position: "投" }] });
  assert.deepEqual((await taro.get("/games/pending")).body.games, []);
  assert.deepEqual((await jiro.get("/games/pending")).body.games.map((x) => x.id), [g.id]);
  // 投手成績だけでも入力済み扱い
  await jiro.put(`/games/${g.id}/pitching/${jiro.member.id}`, { outs: 21 });
  assert.deepEqual((await jiro.get("/games/pending")).body.games, []);
  d = (await admin.get(`/games/${g.id}`)).body;
  assert.deepEqual(d.pending, []);
});

test("試合情報の編集・削除・最新結果", async () => {
  const { admin, taro } = await setup();
  const g = await mkGame(admin);
  assert.equal((await taro.patch(`/games/${g.id}`, { memo: "x" })).status, 403);
  const p = await admin.patch(`/games/${g.id}`, { memo: "ナイスゲーム", date: "2026-10-17", kind: "tournament" });
  assert.equal(p.body.game.memo, "ナイスゲーム");
  assert.equal(p.body.game.kind, "tournament");
  assert.equal((await admin.patch(`/games/${g.id}`, { kind: "x" })).status, 400);
  assert.equal((await taro.get("/games/latest")).body.game, null);
  await admin.put(`/games/${g.id}/score`, { ourScore: 2, theirScore: 4 });
  await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["1B", "2B"] });
  const l = (await taro.get("/games/latest")).body;
  assert.equal(l.game.result, "lose");
  assert.equal(l.hits, 2);
  await taro.put(`/games/${g.id}/batting/${taro.member.id}`, { atBats: ["1B"] });
  assert.equal((await taro.del(`/games/${g.id}`)).status, 403);
  assert.equal((await admin.del(`/games/${g.id}`)).status, 200);
  assert.equal((await taro.get(`/games/${g.id}`)).status, 404);
  assert.equal(admin.member && (await admin.get("/games")).body.games.length, 0);
});
