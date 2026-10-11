import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeTeam } from "./helpers/team.js";
import {
  buildImport,
  decodeEntities,
  normName,
  parseGame,
  parseGameList,
  parseOuts,
  parsePlayers,
  parseTeamStats,
} from "../src/team/importer/teamsone.js";
import { parseSlug } from "../src/team/features/importer.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "teamsone");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const gameIds = fs
  .readdirSync(DIR)
  .map((f) => f.match(/^game_(\d+)\.html$/)?.[1])
  .filter(Boolean);
const LISTS = ["game.html", "game_page_2.html", "game_page_3.html"];

function fixtureImport() {
  return buildImport({
    player: read("player.html"),
    top: read("top.html"),
    gameLists: LISTS.map(read),
    games: Object.fromEntries(gameIds.map((id) => [id, read(`game_${id}.html`)])),
  });
}

// ---------------------------------------------------------------- パーサー

test("parser: 選手名鑑から16人（背番号・投打・守備・役職）", () => {
  const { teamName, players } = parsePlayers(read("player.html"));
  assert.equal(teamName, "常磐ブルドックス");
  assert.equal(players.length, 16);
  const mizukami = players.find((p) => p.name === "水上　靖之");
  assert.deepEqual(
    { number: mizukami.number, positions: mizukami.positions, throws: mizukami.throws, bats: mizukami.bats },
    { number: "1", positions: ["投"], throws: "左", bats: "右" },
  );
  const omatsu = players.find((p) => normName(p.name) === "大松聖弥");
  assert.equal(omatsu.throws, "右");
  assert.equal(omatsu.bats, "左");
  assert.deepEqual(omatsu.positions, []); // 内野手は空
  assert.equal(omatsu.role, "副キャプテン / 会計");
  const catcher = players.find((p) => p.name === "水上　裕太");
  assert.deepEqual(catcher.positions, ["捕"]);
  assert.equal(catcher.role, "監督");
  // 重複した役職はまとめる
  assert.equal(players.find((p) => p.name === "中川　純一").role, "副キャプテン / 広報");
  assert.equal(players.find((p) => p.name === "飯島 良太").number, "16");
});

test("parser: 試合一覧3ページで48試合・ページ送り", () => {
  const pages = LISTS.map((f) => parseGameList(read(f)));
  assert.deepEqual(pages.map((p) => p.games.length), [20, 20, 8]);
  assert.deepEqual(pages.map((p) => p.hasNext), [true, true, false]);
  const ids = new Set(pages.flatMap((p) => p.games.map((g) => g.sourceId)));
  assert.equal(ids.size, 48);
  assert.deepEqual(pages[0].games[0], { sourceId: "1006907", date: "2026-10-11", opponent: "チームJ", score: "1-3", result: "負け" });
});

test("parser: 全48試合を解析（年度別の試合数）", () => {
  const r = fixtureImport();
  assert.equal(r.games.length, 48);
  const count = {};
  for (const g of r.games) count[g.date.slice(0, 4)] = (count[g.date.slice(0, 4)] || 0) + 1;
  assert.deepEqual(count, { 2023: 1, 2024: 21, 2025: 17, 2026: 9 });
  // 全試合でスコアが読め、イニング得点の合計と一致する
  for (const g of r.games) {
    assert.ok(Number.isInteger(g.ourScore) && Number.isInteger(g.theirScore), g.sourceId);
    if (g.lineUs) assert.equal(g.lineUs.reduce((a, b) => a + (b || 0), 0), g.ourScore, g.sourceId);
  }
  // 選手名鑑に無い名前は試合に出ていない（このフィクスチャでは）
  const roster = new Set(r.players.map((p) => normName(p.name)));
  for (const g of r.games) for (const b of g.batting) assert.ok(roster.has(normName(b.name)), b.name);
  // チームトップの年度別成績
  assert.deepEqual(r.teamStats.map((s) => [s.season, s.games, s.win, s.lose, s.draw]), [
    [2026, 9, 3, 5, 1],
    [2025, 17, 5, 11, 1],
  ]);
});

test("parser: 試合 1006880 の概要・スコアボード・打撃・投手成績", () => {
  const g = parseGame(read("game_1006880.html"), "1006880");
  assert.equal(g.date, "2026-07-12");
  assert.equal(g.kind, "league");
  assert.equal(g.opponent, "日の出ホーマーズ");
  assert.equal(g.batFirst, 1);
  assert.equal(g.ourScore, 6);
  assert.equal(g.theirScore, 1);
  assert.deepEqual(g.lineUs, [0, 0, 3, 3, 0, 0]);
  assert.deepEqual(g.lineThem, [0, 0, 1, 0, 0, 0]);
  assert.equal(g.batting.length, 12);
  const fujita = g.batting.find((b) => b.name === "ＧＤ　藤田");
  assert.deepEqual(
    { pa: fujita.pa, ab: fujita.ab, h: fujita.h, hr: fujita.hr, rbi: fujita.rbi, r: fujita.r, number: fujita.number },
    { pa: 3, ab: 2, h: 2, hr: 1, rbi: 1, r: 2, number: "9" },
  );
  const nakagawa = g.batting.find((b) => b.name === "中川　純一");
  assert.deepEqual([nakagawa.ab, nakagawa.h, nakagawa.d3, nakagawa.rbi], [3, 2, 1, 1]);
  const iijima = g.batting.find((b) => b.name === "飯島 良太");
  assert.deepEqual([iijima.pa, iijima.ab, iijima.bb], [3, 1, 2]);
  assert.equal(g.batting.find((b) => b.name === "大松　聖弥").e, 1);
  assert.equal(g.batting.find((b) => b.name === "内藤　晃大").sb, 1);
  assert.deepEqual(
    g.pitching.map((p) => [p.name, p.order_no, p.outs, p.r, p.er, p.so, p.bb, p.decision]),
    [
      ["山口　陽常", 1, 15, 1, 0, 6, 2, "W"],
      ["水上　裕太", 2, 6, 0, 0, 3, 3, "S"],
    ],
  );
  assert.deepEqual(g.warnings, []);
});

test("parser: 投球回 → アウト数", () => {
  assert.equal(parseOuts("5回0/3"), 15);
  assert.equal(parseOuts("2回1/3"), 7);
  assert.equal(parseOuts("0回2/3"), 2);
  assert.equal(parseOuts("1/3"), 1);
  assert.equal(parseOuts("7回"), 21);
  assert.equal(parseOuts("-"), 0);
  assert.equal(parseOuts(""), 0);
});

test("parser: サヨナラ表記（4x）・後攻・大会名・開始時刻・球場", () => {
  const w = parseGame(read("game_821868.html"), "821868");
  assert.equal(w.walkOff, true);
  assert.equal(w.batFirst, 1);
  assert.equal(w.ourScore, 3);
  assert.equal(w.theirScore, 4);
  assert.equal(w.opponent, "シャドーズ");

  const o = parseGame(read("game_754642.html"), "754642");
  assert.equal(o.batFirst, 0);
  assert.equal(o.opponent, "ナイトフィーバーズ");
  assert.equal(o.ourScore, 9);
  assert.equal(o.theirScore, 10);
  assert.equal(o.kind, "friendly");
  assert.equal(o.title, "オープン戦");
  assert.equal(o.startTime, "13:00");
  assert.equal(o.venue, "しらこばと球場");

  const t = parseGame(read("game_839348.html"), "839348");
  assert.equal(t.title, "プライドジャパンカップ秋季大会");
  assert.equal(t.batFirst, 0);
  assert.deepEqual([t.ourScore, t.theirScore], [11, 1]);

  // スコアボードのセルに x が付いた場合
  const html = read("game_821868.html").replace("<td>2</td>\n                      <td></td>\n                      <td></td>\n                      <td></td>", "<td>2x</td>\n<td></td><td></td><td></td>");
  assert.notEqual(html, read("game_821868.html"));
  const x = parseGame(html, "821868");
  assert.equal(x.walkOff, true);
  assert.deepEqual(x.lineThem, [0, 0, 0, 2, 0, 2]);
});

test("parser: テーブルが3個の試合（投手成績なし）はスコアと打撃だけ", () => {
  const g = parseGame(read("game_795842.html"), "795842");
  assert.equal(g.hasBatting, true);
  assert.equal(g.hasPitching, false);
  assert.deepEqual(g.pitching, []);
  assert.deepEqual([g.ourScore, g.theirScore], [6, 9]);
  assert.deepEqual(g.lineUs, [6]);
  // 成績表が1つも無い試合
  const bare = read("game_795842.html").replace(/<section class="battingPitchingContainer">[\s\S]*<\/section>/, "");
  const b = parseGame(bare, "795842");
  assert.equal(b.hasBatting, false);
  assert.deepEqual([b.ourScore, b.theirScore], [6, 9]);
});

test("parser: 安打は長打を含む総数（矛盾行は長打側を補正）", () => {
  const r = fixtureImport();
  for (const g of r.games) {
    for (const b of g.batting) {
      assert.ok(b.h >= b.d2 + b.d3 + b.hr, `${g.sourceId} ${b.name}`);
      assert.ok(b.ab >= b.h, `${g.sourceId} ${b.name}`);
      assert.ok(b.pa >= b.ab + b.bb + b.hbp + b.sh + b.sf, `${g.sourceId} ${b.name}`);
    }
    for (const p of g.pitching) assert.ok(p.er <= p.r);
  }
  // 「安打 + 長打 > 打数」の行がある → teams.one の安打は長打込み
  assert.ok(r.games.some((g) => g.batting.some((b) => b.h + b.d2 + b.d3 + b.hr > b.ab)));
  assert.ok(r.warnings.some((w) => w.includes("長打")));
});

test("parser: エンティティのデコード・slug の検証", () => {
  assert.equal(decodeEntities("A&amp;B &#x3042;&#12354; &nbsp;&rsaquo;"), "A&B ああ  ›");
  assert.equal(normName("水上　靖之"), "水上靖之");
  assert.equal(parseSlug("joban-bulldogs"), "joban-bulldogs");
  assert.equal(parseSlug("https://teams.one/teams/joban-bulldogs/game?page=2"), "joban-bulldogs");
  assert.throws(() => parseSlug("../evil"));
  assert.throws(() => parseSlug("https://example.com/teams/x"));
  assert.throws(() => parseSlug("a b"));
  assert.deepEqual(parseTeamStats("<table><tr><th>年</th><th>試合</th><th>勝ち</th></tr><tr><td>2026</td><td>3</td><td>1</td></tr></table>")[0].games, 3);
});

// ---------------------------------------------------------------- 取り込み API

// globalThis.fetch をフィクスチャ読み込みに差し替える
function stubFetch({ dropPlayer = null } = {}) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    new Headers(opts.headers); // 本物の fetch と同じくヘッダーの文字を検証する
    calls.push({ url: String(url), headers: opts.headers });
    const u = new URL(url);
    assert.equal(u.origin, "https://teams.one");
    const m = u.pathname.match(/^\/teams\/joban-bulldogs(\/.*)?$/);
    if (!m) return new Response("not found", { status: 404 });
    const sub = m[1] || "";
    let file = null;
    if (sub === "" || sub === "/") file = "top.html";
    else if (sub === "/player") file = "player.html";
    else if (sub === "/game") file = u.searchParams.get("page") && u.searchParams.get("page") !== "1" ? `game_page_${u.searchParams.get("page")}.html` : "game.html";
    else if (/^\/game\/\d+$/.test(sub)) file = `game_${sub.split("/")[2]}.html`;
    if (!file || !fs.existsSync(path.join(DIR, file))) return new Response("not found", { status: 404 });
    let body = read(file);
    if (file === "player.html" && dropPlayer) {
      body = body.replace(new RegExp(`<li class="col-xs-6[^"]*">(?:(?!</li>)[\\s\\S])*${dropPlayer}[\\s\\S]*?</li>`), "");
    }
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const count = async (t, table, where = "") => (await t.db.one(`SELECT COUNT(*) AS n FROM ${table} ${where}`)).n;

test("api: 管理者以外は 403、slug の検証", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const f = stubFetch();
  try {
    assert.equal((await taro.post("/import/teamsone", { slug: "joban-bulldogs", dryRun: true })).status, 403);
    assert.equal((await t.anon.post("/import/teamsone", { slug: "joban-bulldogs" })).status, 401);
    assert.equal((await admin.post("/import/teamsone", { slug: "../x" })).status, 400);
    assert.equal(f.calls.length, 0);
    const nf = await admin.post("/import/teamsone", { slug: "no-such-team" });
    assert.equal(nf.status, 400);
    assert.match(nf.body.message, /見つかりません/);
  } finally {
    f.restore();
  }
});

test("api: dryRun は DB を変えずに結果だけ返す", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const f = stubFetch();
  try {
    const before = [await count(t, "members"), await count(t, "games"), await count(t, "batting"), await count(t, "pitching")];
    const res = await admin.post("/import/teamsone", { slug: "joban-bulldogs", dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.players.created, 16);
    assert.equal(res.body.games.created, 48);
    assert.equal(res.body.gameList.length, 48);
    assert.equal(res.body.playerList.length, 16);
    assert.deepEqual(
      res.body.seasons.map((s) => [s.season, s.games, s.win, s.lose, s.draw]),
      [
        [2026, 9, 4, 4, 1],
        [2025, 17, 5, 10, 2],
        [2024, 21, 5, 12, 4],
        [2023, 1, 0, 1, 0],
      ],
    );
    const after = [await count(t, "members"), await count(t, "games"), await count(t, "batting"), await count(t, "pitching")];
    assert.deepEqual(after, before);
    assert.equal(await count(t, "import_map"), 0);
    // User-Agent を付け、teams.one のチームページ以外は取得しない
    assert.ok(f.calls.every((c) => c.url.startsWith("https://teams.one/teams/joban-bulldogs")));
    assert.ok(f.calls.every((c) => /^[\x20-\x7e]+$/.test(c.headers["User-Agent"])), "User-Agent は ASCII のみ");
    assert.equal(f.calls.filter((c) => /\/game\/\d+$/.test(c.url)).length, 48);
  } finally {
    f.restore();
  }
});

test("api: 取り込み → 2回目は件数が増えない・既存同名メンバーへの対応付け・退団者 active=0", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  // アプリに既にいる同名メンバー（空白の有無が違う）。背番号は空欄、投打は設定済み
  const yamaguchi = await t.join("山口陽常", { throws: "左" });
  const f = stubFetch({ dropPlayer: "戸部　大河" });
  try {
    const res = await admin.post("/import/teamsone", { slug: "joban-bulldogs" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.players.roster, 15);
    assert.equal(res.body.players.linked, 1);
    assert.equal(res.body.players.created, 15); // 名鑑14人 + 退団者1人
    assert.equal(res.body.players.departed, 1);
    assert.equal(res.body.games.created, 48);

    const members = await count(t, "members");
    const games = await count(t, "games");
    const batting = await count(t, "batting");
    const pitching = await count(t, "pitching");
    assert.equal(members, 2 + 15);
    assert.equal(games, 48);
    assert.equal(await count(t, "games", "WHERE status = 'final' AND event_id IS NULL"), 48);
    assert.equal(await count(t, "games_at_bats"), 0);

    // 既存メンバー: 新規作成されず、空欄の背番号・守備だけ埋まる（投打は設定済みの値のまま）
    const y = await t.db.one("SELECT * FROM members WHERE id = ?", yamaguchi.member.id);
    assert.equal(y.number, "18");
    assert.equal(y.positions, "投");
    assert.equal(y.throws, "左");
    assert.equal(y.bats, "右");
    assert.ok(y.line_user_id);
    assert.equal(await count(t, "members", "WHERE name LIKE '山口%'"), 1);
    // 名鑑の選手: LINE 未連携・助っ人でない・在籍
    const omatsu = await t.db.one("SELECT * FROM members WHERE name = '大松　聖弥'");
    assert.deepEqual(
      [omatsu.line_user_id, omatsu.is_guest, omatsu.active, omatsu.number, omatsu.throws, omatsu.bats, omatsu.positions, omatsu.role],
      [null, 0, 1, "6", "右", "左", "", "member"],
    );
    // 退団者（名鑑に無いが試合に出ている）
    const tobe = await t.db.one("SELECT * FROM members WHERE name = '戸部　大河'");
    assert.equal(tobe.active, 0);
    assert.equal(tobe.is_guest, 0);
    assert.equal(tobe.number, "33");

    // 試合の中身
    const g = await t.db.one("SELECT * FROM games WHERE date = '2026-07-12'");
    assert.deepEqual(
      [g.season, g.opponent, g.kind, g.bat_first, g.our_score, g.their_score, g.innings, g.line_us, g.line_them],
      [2026, "日の出ホーマーズ", "league", 1, 6, 1, 7, "[0,0,3,3,0,0]", "[0,0,1,0,0,0]"],
    );
    assert.match(g.memo, /teams\.one から取り込み/);
    const cup = await t.db.one("SELECT * FROM games WHERE date = '2024-10-20'");
    assert.equal(cup.kind, "tournament");
    assert.match(cup.memo, /プライドジャパンカップ秋季大会/);
    const open = await t.db.one("SELECT * FROM games WHERE date = '2023-12-17'");
    assert.equal(open.kind, "friendly");
    assert.equal(open.venue, "しらこばと球場");
    assert.equal(open.bat_first, 0);
    const pit = await t.db.all("SELECT * FROM pitching WHERE game_id = ? ORDER BY order_no", g.id);
    assert.deepEqual(pit.map((p) => [p.member_id, p.outs, p.decision]), [
      [yamaguchi.member.id, 15, "W"],
      [(await t.db.one("SELECT id FROM members WHERE name = '水上　裕太'")).id, 6, "S"],
    ]);

    // 手で成績を変えても、再実行で teams.one の値に戻る。件数は増えない
    await t.db.run("UPDATE batting SET h = 0 WHERE game_id = ?", g.id);
    await t.db.run("UPDATE games SET our_score = 0 WHERE id = ?", g.id);
    const res2 = await admin.post("/import/teamsone", { slug: "joban-bulldogs" });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.games.created, 0);
    assert.equal(res2.body.games.updated, 48);
    assert.equal(res2.body.players.created, 0);
    assert.equal(await count(t, "members"), members);
    assert.equal(await count(t, "games"), games);
    assert.equal(await count(t, "batting"), batting);
    assert.equal(await count(t, "pitching"), pitching);
    assert.equal((await t.db.one("SELECT our_score FROM games WHERE id = ?", g.id)).our_score, 6);
    assert.equal((await t.db.one("SELECT SUM(h) AS h FROM batting WHERE game_id = ?", g.id)).h, 7);

    // アプリ側で名前を変えても対応付けは保たれる
    await t.db.run("UPDATE members SET name = 'おおまつ' WHERE id = ?", omatsu.id);
    const res3 = await admin.post("/import/teamsone", { slug: "joban-bulldogs", dryRun: true });
    assert.equal(res3.body.players.created, 0);
  } finally {
    f.restore();
  }
});

test("api: 取り込んだ成績が stats API に反映される（退団者も通算・年度別・チーム成績に含む）", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const f = stubFetch({ dropPlayer: "戸部　大河" });
  try {
    assert.equal((await admin.post("/import/teamsone", { slug: "joban-bulldogs" })).status, 200);
  } finally {
    f.restore();
  }
  const team = (await admin.get("/stats/team?season=2026")).body;
  assert.deepEqual([team.games, team.w, team.l, team.d, team.runs, team.allowed], [9, 4, 4, 1, 27, 26]);
  const career = (await admin.get("/stats/team?season=career")).body;
  assert.equal(career.games, 48);
  const seasons = (await admin.get("/stats/seasons")).body.seasons;
  assert.deepEqual(seasons, [2026, 2025, 2024, 2023]);

  const tobe = await t.db.one("SELECT * FROM members WHERE name = '戸部　大河'");
  const bat = (await admin.get("/stats/batting?season=career")).body.players;
  const row = bat.find((p) => p.member.id === tobe.id);
  assert.ok(row, "退団者も通算成績に含まれる");
  assert.equal(row.member.active, false);
  const sum = await t.db.one("SELECT SUM(b.h) AS h, SUM(b.ab) AS ab FROM batting b WHERE b.member_id = ?", tobe.id);
  assert.equal(row.totals.h, sum.h);
  assert.equal(row.totals.ab, sum.ab);
  // チーム打撃成績は全員分（退団者込み）
  const all = await t.db.one("SELECT SUM(h) AS h, SUM(ab) AS ab FROM batting");
  assert.ok(Math.abs(career.avg - all.h / all.ab) < 1e-9);

  // 選手ページ: 年度別・試合ごとの成績
  const yama = await t.db.one("SELECT * FROM members WHERE name = '山口　陽常'");
  const page = (await admin.get(`/stats/players/${yama.id}`)).body;
  assert.ok(page.byYear.length >= 2);
  assert.ok(page.career.pitching.totals.outs > 0);
  assert.ok(page.gameLog.length > 0);
  assert.equal(page.isPitcher, true);
  const tobePage = (await admin.get(`/stats/players/${tobe.id}`)).body;
  assert.ok(tobePage.career.batting);

  // ランキング（今季）
  const leaders = (await admin.get("/stats/leaders?season=2026")).body;
  assert.ok(leaders.batting.find((c) => c.key === "h").leaders.length > 0);
  assert.ok(leaders.pitching.find((c) => c.key === "so").leaders.length > 0);
});

test("api: 役職は members.title に入れる（空欄のときだけ。role は変えない）", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  // members-001（members 機能）で追加される列。未適用の環境でも試せるようにここで追加
  await t.db.exec("ALTER TABLE members ADD COLUMN IF NOT EXISTS title TEXT");
  const kawamura = await t.join("河村 誠貴");
  await t.db.run("UPDATE members SET title = '主将' WHERE id = ?", kawamura.member.id);
  const f = stubFetch();
  try {
    const res = await admin.post("/import/teamsone", { slug: "joban-bulldogs" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.playerList.find((p) => p.name === "水上　裕太").title, "監督");
  } finally {
    f.restore();
  }
  const row = async (name) => t.db.one("SELECT title, role FROM members WHERE name = ?", name);
  assert.deepEqual({ ...(await row("水上　裕太")) }, { title: "監督", role: "member" });
  assert.equal((await row("大松　聖弥")).title, "副キャプテン / 会計");
  assert.equal((await row("山口　陽常")).title, "ツッコミ");
  assert.equal((await row("上原　幸浩")).title, null);
  // 既存メンバーの役職は上書きしない
  assert.equal((await row("河村 誠貴")).title, "主将");
  assert.equal(parsePlayers(read("player.html")).players.find((p) => p.name === "河村　誠貴").title, "キャプテン / GM");
});
