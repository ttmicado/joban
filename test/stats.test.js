import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";

// games / batting / pitching へ直接書き込むヘルパー
function addGame(t, { season = 2026, date = "2026-05-01", status = "final", our = 5, their = 3, opponent = "川口ファイターズ" } = {}) {
  return t.db.run(
    `INSERT INTO games(season, date, opponent, our_score, their_score, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 0, 0)`,
    season, date, opponent, our, their, status,
  ).lastId;
}
function bat(t, gameId, memberId, s) {
  const r = { pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, r: 0, so: 0, bb: 0, hbp: 0, sh: 0, sf: 0, sb: 0, ...s };
  t.db.run(
    `INSERT INTO batting(game_id, member_id, pa, ab, h, d2, d3, hr, rbi, r, so, bb, hbp, sh, sf, sb, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    gameId, memberId, r.pa, r.ab, r.h, r.d2, r.d3, r.hr, r.rbi, r.r, r.so, r.bb, r.hbp, r.sh, r.sf, r.sb,
  );
}
function pit(t, gameId, memberId, s) {
  const r = { outs: 0, h: 0, so: 0, bb: 0, r: 0, er: 0, decision: null, ...s };
  t.db.run(
    `INSERT INTO pitching(game_id, member_id, outs, h, so, bb, r, er, decision, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    gameId, memberId, r.outs, r.h, r.so, r.bb, r.r, r.er, r.decision,
  );
}

async function setup() {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("監督");
  const taro = await t.join("太郎", { positions: ["投"] });
  const jiro = await t.join("次郎");
  const guest = (await admin.post("/members", { name: "助っ人" })).body.member;
  return { t, admin, taro, jiro, guest };
}

test("draft の試合は集計に含めない・規定打席の判定", async () => {
  const { t, admin, taro, jiro } = await setup();
  const g1 = addGame(t, { date: "2026-05-01" });
  const g2 = addGame(t, { date: "2026-05-08", our: 1, their: 4 });
  const d = addGame(t, { date: "2026-05-15", status: "draft" });
  // 規定打席 = 2試合 × 2 = 4
  bat(t, g1, taro.member.id, { pa: 3, ab: 3, h: 2 });
  bat(t, g2, taro.member.id, { pa: 1, ab: 1, h: 0 });
  bat(t, g1, jiro.member.id, { pa: 3, ab: 3, h: 3 });
  bat(t, d, taro.member.id, { pa: 5, ab: 5, h: 5, hr: 5 });

  const res = await admin.get("/stats/batting?season=2026");
  assert.equal(res.status, 200);
  assert.equal(res.body.qualify.games, 2);
  assert.equal(res.body.qualify.pa, 4);
  const p = Object.fromEntries(res.body.players.map((x) => [x.member.name, x]));
  assert.equal(p["太郎"].totals.pa, 4);
  assert.equal(p["太郎"].totals.hr, 0, "draft の本塁打は入らない");
  assert.equal(p["太郎"].games, 2);
  assert.equal(p["太郎"].rates.avg, 0.5);
  assert.equal(p["太郎"].qualified, true);
  assert.equal(p["次郎"].qualified, false);

  // 打率ランキングは規定到達者のみ（次郎の 1.000 は入らない）
  const l = await jiro.get("/stats/leaders?season=2026");
  const avg = l.body.batting.find((c) => c.key === "avg");
  assert.deepEqual(avg.leaders.map((x) => x.member.name), ["太郎"]);
  assert.equal(avg.me.rank, null);
  assert.deepEqual(avg.me.needed, { unit: "打席", n: 1 });
  // 安打は積み上げなので規定不要
  const h = l.body.batting.find((c) => c.key === "h");
  assert.equal(h.leaders[0].member.name, "次郎");
  assert.equal(h.me.rank, 1);
});

test("同率は同順位・助っ人はランキング対象外・0 は載らない", async () => {
  const { t, admin, taro, jiro, guest } = await setup();
  const g = addGame(t);
  bat(t, g, taro.member.id, { pa: 4, ab: 4, h: 2, hr: 1 });
  bat(t, g, jiro.member.id, { pa: 4, ab: 4, h: 2, hr: 1 });
  bat(t, g, admin.member.id, { pa: 4, ab: 4, h: 1 });
  bat(t, g, guest.id, { pa: 4, ab: 4, h: 4, hr: 3 });
  const l = (await admin.get("/stats/leaders")).body;
  const hr = l.batting.find((c) => c.key === "hr");
  assert.deepEqual(hr.leaders.map((x) => [x.member.name, x.rank]), [["太郎", 1], ["次郎", 1]]);
  assert.equal(hr.me.rank, null); // 0本は載らない
  const avg = l.batting.find((c) => c.key === "avg");
  assert.deepEqual(avg.leaders.map((x) => x.rank), [1, 1, 3]);
  assert.equal(avg.me.rank, 3);
  // 成績表には助っ人も出る
  const all = (await admin.get("/stats/batting")).body.players;
  assert.ok(all.some((x) => x.member.isGuest));
});

test("投手成績・規定投球回・防御率は規定イニング基準", async () => {
  const { t, admin, taro, jiro } = await setup();
  const g1 = addGame(t, { date: "2026-05-01" });
  const g2 = addGame(t, { date: "2026-05-08" });
  pit(t, g1, taro.member.id, { outs: 21, er: 2, so: 8, h: 5, bb: 2, decision: "W" });
  pit(t, g2, taro.member.id, { outs: 12, er: 1, so: 3, decision: "W" });
  pit(t, g2, jiro.member.id, { outs: 3, er: 0, so: 1, decision: "S" });
  const res = (await admin.get("/stats/pitching")).body;
  assert.equal(res.qualify.ip, 2);
  const p = Object.fromEntries(res.players.map((x) => [x.member.name, x]));
  assert.equal(p["太郎"].totals.w, 2);
  assert.equal(p["太郎"].rates.era, (3 * 7) / 11);
  assert.equal(p["太郎"].qualified, true);
  assert.equal(p["次郎"].qualified, false, "1回 < 規定2回");
  const l = (await jiro.get("/stats/leaders")).body.pitching;
  const era = l.find((c) => c.key === "era");
  assert.deepEqual(era.leaders.map((x) => x.member.name), ["太郎"]);
  assert.deepEqual(era.me.needed, { unit: "回", n: 1, outs: 3 });
  assert.equal(l.find((c) => c.key === "sv").leaders[0].member.name, "次郎");
  assert.equal(l.find((c) => c.key === "w").leaders[0].value, 2);
});

test("通算と年度別・シーズン一覧", async () => {
  const { t, admin, taro } = await setup();
  const a = addGame(t, { season: 2025, date: "2025-06-01" });
  const b = addGame(t, { season: 2026, date: "2026-06-01" });
  bat(t, a, taro.member.id, { pa: 4, ab: 4, h: 1, hr: 1 });
  bat(t, b, taro.member.id, { pa: 4, ab: 4, h: 3 });
  const y25 = (await admin.get("/stats/batting?season=2025")).body.players[0];
  const y26 = (await admin.get("/stats/batting")).body.players[0];
  const car = (await admin.get("/stats/batting?season=career")).body;
  assert.equal(y25.totals.h, 1);
  assert.equal(y26.totals.h, 3);
  assert.equal(car.season, "career");
  assert.equal(car.players[0].totals.h, 4);
  assert.equal(car.players[0].totals.hr, 1);
  assert.equal(car.qualify.games, 2);
  assert.deepEqual((await admin.get("/stats/seasons")).body, { seasons: [2026, 2025], current: 2026 });
  assert.equal((await admin.get("/stats/batting?season=abc")).status, 400);
});

test("チーム成績（勝敗・得失点・直近5試合・連勝）", async () => {
  const { t, admin, taro } = await setup();
  const scores = [[3, 1], [2, 5], [4, 4], [6, 0], [1, 0], [7, 3]];
  scores.forEach(([our, their], i) => addGame(t, { date: `2026-05-0${i + 1}`, our, their }));
  addGame(t, { date: "2026-05-09", our: 0, their: 20, status: "draft" });
  bat(t, 1, taro.member.id, { pa: 4, ab: 4, h: 2, hr: 1, sb: 1 });
  pit(t, 1, taro.member.id, { outs: 21, er: 1 });
  const s = (await admin.get("/stats/team")).body;
  assert.equal(s.games, 6);
  assert.deepEqual([s.w, s.l, s.d], [4, 1, 1]);
  assert.equal(s.winPct, 0.8);
  assert.equal(s.runs, 23);
  assert.equal(s.allowed, 13);
  assert.equal(s.avg, 0.5);
  assert.equal(s.era, 1);
  assert.equal(s.hr, 1);
  assert.equal(s.sb, 1);
  assert.equal(s.recent.length, 5);
  assert.equal(s.recent[0].date, "2026-05-06");
  assert.deepEqual(s.streak, { result: "win", n: 3 });
});

test("選手ページ: 今季・通算・年度別・試合ログ・タイトル・順位", async () => {
  const { t, admin, taro, jiro } = await setup();
  // 2025: 太郎が首位打者・本塁打王、次郎が打点王
  const a1 = addGame(t, { season: 2025, date: "2025-05-01" });
  bat(t, a1, taro.member.id, { pa: 4, ab: 4, h: 3, hr: 2, rbi: 2 });
  bat(t, a1, jiro.member.id, { pa: 4, ab: 4, h: 1, rbi: 4 });
  pit(t, a1, taro.member.id, { outs: 21, er: 1, so: 9, decision: "W" });
  // 2026（今季）はタイトル対象外
  const b1 = addGame(t, { season: 2026, date: "2026-05-01", our: 2, their: 3, opponent: "大宮キングス" });
  const b2 = addGame(t, { season: 2026, date: "2026-05-08" });
  bat(t, b1, taro.member.id, { pa: 4, ab: 4, h: 1, rbi: 1 });
  bat(t, b2, taro.member.id, { pa: 4, ab: 3, h: 2, hr: 1, bb: 1, rbi: 3 });
  bat(t, b1, jiro.member.id, { pa: 4, ab: 4, h: 0 });
  bat(t, b2, jiro.member.id, { pa: 4, ab: 4, h: 1 });

  const res = await jiro.get(`/stats/players/${taro.member.id}`);
  assert.equal(res.status, 200);
  const p = res.body;
  assert.equal(p.member.name, "太郎");
  assert.equal(p.member.line_user_id, undefined);
  assert.equal(p.current.batting.totals.h, 3);
  assert.equal(p.career.batting.totals.h, 6);
  assert.equal(p.career.pitching.totals.w, 1);
  assert.equal(p.current.pitching, null);
  assert.deepEqual(p.byYear.map((y) => y.season), [2026, 2025]);
  assert.equal(p.gameLog.length, 3);
  assert.equal(p.gameLog[0].date, "2026-05-08");
  assert.equal(p.gameLog[0].batting.line, "3打数2安打 1本塁打 3打点 四死球1");
  assert.equal(p.gameLog[1].opponent, "大宮キングス");
  assert.equal(p.gameLog[1].result, "lose");
  assert.match(p.gameLog[2].pitching.line, /^7回 0失点 9奪三振 勝利投手$/);
  assert.deepEqual(p.titles.map((x) => `${x.season}${x.label}`).sort(), ["2025最多勝", "2025最多奪三振", "2025最優秀防御率", "2025本塁打王", "2025首位打者"].sort());
  assert.deepEqual(p.trend.points.map((x) => Number(x.avg.toFixed(3))), [0.25, 0.429]);
  assert.equal(p.trend.scope, "season");
  assert.equal(p.form.h, 3);
  assert.equal(p.isPitcher, true);
  const avgRank = p.ranks.find((r) => r.key === "avg");
  assert.equal(avgRank.rank, 1);
  assert.equal(avgRank.of, 2);

  const j = (await admin.get(`/stats/players/${jiro.member.id}`)).body;
  assert.deepEqual(j.titles.map((x) => x.label), ["打点王"]);
  assert.equal((await admin.get("/stats/players/9999")).status, 404);
  assert.equal((await admin.get("/stats/players/abc")).status, 400);
});

test("記録がない選手・未参加は見られない", async () => {
  const { t, admin } = await setup();
  const p = (await admin.get(`/stats/players/${admin.member.id}`)).body;
  assert.equal(p.current.batting, null);
  assert.deepEqual(p.gameLog, []);
  assert.equal(p.form, null);
  const l = (await admin.get("/stats/leaders")).body;
  assert.ok(l.batting.every((c) => c.leaders.length === 0));
  assert.equal((await t.user("部外者").get("/stats/leaders")).status, 403);
  assert.equal((await t.anon.get("/stats/team")).status, 401);
});

test("dev-seed は ALLOW_MOCK=true の管理者だけ・本番は 404", async () => {
  const prod = makeTeam();
  const a = await prod.join("監督");
  assert.equal((await a.post("/stats/dev-seed")).status, 404);
  assert.equal((await prod.anon.post("/stats/dev-seed")).status, 404);
  const prod2 = makeTeam({ env: { ALLOW_MOCK: "false" } });
  assert.equal((await (await prod2.join("監督")).post("/stats/dev-seed")).status, 404);

  const dev = makeTeam({ env: { ALLOW_MOCK: "true" } });
  const admin = await dev.join("監督");
  const member = await dev.join("太郎");
  assert.equal((await member.post("/stats/dev-seed")).status, 403);
  assert.equal((await dev.anon.post("/stats/dev-seed")).status, 401);
  const r = await admin.post("/stats/dev-seed", {});
  assert.equal(r.status, 200);
  const team = (await admin.get("/stats/team")).body;
  assert.equal(team.games, 8);
  assert.ok((await admin.get("/stats/batting")).body.players.length >= 9);
  // 2回実行しても重複しない
  await admin.post("/stats/dev-seed", {});
  assert.equal((await admin.get("/stats/team")).body.games, 8);
  assert.equal(dev.db.one("SELECT COUNT(*) AS n FROM games WHERE status = 'draft'").n, 1);
});
