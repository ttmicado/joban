// 個人成績・ランキング・チーム成績・選手ページ（読み取り専用。集計対象は status = 'final' の試合のみ）
import { ApiError, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";
import {
  battingRates,
  battingTotals,
  fmtIP,
  gameResult,
  pitchingRates,
  pitchingTotals,
} from "../../../public/app/lib/stats.js";

// 規定打席 = 確定試合数 × 2（草野球向け）、規定投球回 = 確定試合数 × 1 回。端数は切り捨て
export const QUALIFY_PA_PER_GAME = 2;
export const QUALIFY_IP_PER_GAME = 1;
// ランキングで返す上位の順位（同率で増えることがある）
const LEADER_RANKS = 5;

// 部門定義。type: rate（.333）/ count（整数）/ dec2（小数2桁）
export const BATTING_CATEGORIES = [
  { key: "avg", label: "打率", type: "rate", order: "desc", qualifiedOnly: true },
  { key: "hr", label: "本塁打", type: "count", order: "desc" },
  { key: "rbi", label: "打点", type: "count", order: "desc" },
  { key: "h", label: "安打", type: "count", order: "desc" },
  { key: "sb", label: "盗塁", type: "count", order: "desc" },
  { key: "obp", label: "出塁率", type: "rate", order: "desc", qualifiedOnly: true },
  { key: "ops", label: "OPS", type: "rate", order: "desc", qualifiedOnly: true },
];
export const PITCHING_CATEGORIES = [
  { key: "era", label: "防御率", type: "dec2", order: "asc", qualifiedOnly: true },
  { key: "w", label: "勝利", type: "count", order: "desc" },
  { key: "so", label: "奪三振", type: "count", order: "desc" },
  { key: "sv", label: "セーブ", type: "count", order: "desc" },
  { key: "whip", label: "WHIP", type: "dec2", order: "asc", qualifiedOnly: true },
];
// 獲得タイトル（過去シーズンの1位。同率は全員受賞）
const TITLES = [
  { side: "batting", key: "avg", label: "首位打者" },
  { side: "batting", key: "hr", label: "本塁打王" },
  { side: "batting", key: "rbi", label: "打点王" },
  { side: "batting", key: "sb", label: "盗塁王" },
  { side: "pitching", key: "era", label: "最優秀防御率" },
  { side: "pitching", key: "w", label: "最多勝" },
  { side: "pitching", key: "so", label: "最多奪三振" },
];
// 選手ページの「チーム内順位」に出す部門
const RANK_KEYS = {
  batting: ["avg", "hr", "rbi", "h", "sb", "ops"],
  pitching: ["era", "w", "so", "sv"],
};

// ---------------------------------------------------------------- 集計

// ?season=YYYY|career → 年度（数値）または null（通算）
function parseSeason(c) {
  const s = c.query.season;
  if (s === undefined || s === "") return Number(c.settings.season);
  if (s === "career") return null;
  return v.int(s, "年度", { min: 2000, max: 2100, required: true });
}

const seasonLabel = (season) => (season === null ? "career" : season);

function finalGames(db, season) {
  return season === null
    ? db.all("SELECT * FROM games WHERE status = 'final' ORDER BY date, id")
    : db.all("SELECT * FROM games WHERE status = 'final' AND season = ? ORDER BY date, id", season);
}

function rowsOf(db, table, season) {
  const sql = `SELECT t.*, g.date AS g_date, g.season AS g_season FROM ${table} t
    JOIN games g ON g.id = t.game_id WHERE g.status = 'final' ${season === null ? "" : "AND g.season = ?"}
    ORDER BY g.date, g.id`;
  return season === null ? db.all(sql) : db.all(sql, season);
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

function membersById(db) {
  return new Map(db.all("SELECT * FROM members").map((m) => [m.id, m]));
}

// シーズン（または通算）の選手ごとの集計
function collect(db, settings, season, members = membersById(db)) {
  const games = finalGames(db, season);
  const n = games.length;
  const innings = Number(settings.inningsPerGame) || 7;
  const qualify = {
    games: n,
    paPerGame: QUALIFY_PA_PER_GAME,
    ipPerGame: QUALIFY_IP_PER_GAME,
    pa: Math.floor(n * QUALIFY_PA_PER_GAME),
    ip: Math.floor(n * QUALIFY_IP_PER_GAME),
    innings,
  };
  const batRows = rowsOf(db, "batting", season);
  const pitRows = rowsOf(db, "pitching", season);

  const batting = [];
  for (const [id, rows] of groupBy(batRows, "member_id")) {
    const m = members.get(id);
    if (!m) continue;
    const totals = battingTotals(rows);
    batting.push({
      member: publicMember(m),
      games: totals.games,
      totals,
      rates: battingRates(totals),
      qualified: n > 0 && totals.pa >= qualify.pa,
    });
  }
  const pitching = [];
  for (const [id, rows] of groupBy(pitRows, "member_id")) {
    const m = members.get(id);
    if (!m) continue;
    const totals = pitchingTotals(rows);
    pitching.push({
      member: publicMember(m),
      games: totals.games,
      totals,
      rates: pitchingRates(totals, innings),
      qualified: n > 0 && totals.outs >= qualify.ip * 3,
    });
  }
  return { season, games, qualify, batting, pitching, batRows, pitRows };
}

const statValue = (p, key) => (key in p.rates ? p.rates[key] : p.totals[key]);
const EPS = 1e-9;

// 同率同順位（1, 1, 3 …）のランキング。助っ人は対象外。積み上げ系は 0 を除く
export function rankCategory(players, cat) {
  const list = [];
  for (const p of players) {
    if (p.member.isGuest) continue;
    const value = statValue(p, cat.key);
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    if (cat.qualifiedOnly && !p.qualified) continue;
    if (cat.type === "count" && !(value > 0)) continue;
    list.push({ member: p.member, value, qualified: p.qualified });
  }
  list.sort((a, b) => (cat.order === "asc" ? a.value - b.value : b.value - a.value) || a.member.id - b.member.id);
  list.forEach((x, i) => {
    x.rank = i > 0 && Math.abs(x.value - list[i - 1].value) < EPS ? list[i - 1].rank : i + 1;
  });
  return list;
}

function categoryView(players, cat, meId, qualify, side) {
  const ranked = rankCategory(players, cat);
  let me = null;
  if (meId) {
    const hit = ranked.find((x) => x.member.id === meId);
    const mine = players.find((p) => p.member.id === meId);
    if (hit) me = { rank: hit.rank, value: hit.value, qualified: hit.qualified };
    else if (mine) {
      me = { rank: null, value: statValue(mine, cat.key), qualified: mine.qualified };
      if (cat.qualifiedOnly && !mine.qualified) {
        // 規定まであと何打席 / 何アウト
        me.needed =
          side === "batting"
            ? { unit: "打席", n: qualify.pa - mine.totals.pa }
            : { unit: "回", n: Math.ceil((qualify.ip * 3 - mine.totals.outs) / 3), outs: qualify.ip * 3 - mine.totals.outs };
      }
    }
  }
  return {
    key: cat.key,
    label: cat.label,
    type: cat.type,
    order: cat.order,
    qualifiedOnly: !!cat.qualifiedOnly,
    total: ranked.length,
    leaders: ranked.filter((x) => x.rank <= LEADER_RANKS).map(({ member, value, rank }) => ({ rank, member, value })),
    me,
  };
}

function leaders(data, meId) {
  return {
    batting: BATTING_CATEGORIES.map((cat) => categoryView(data.batting, cat, meId, data.qualify, "batting")),
    pitching: PITCHING_CATEGORIES.map((cat) => categoryView(data.pitching, cat, meId, data.qualify, "pitching")),
  };
}

const strip = (p) => ({ member: p.member, games: p.games, totals: p.totals, rates: p.rates, qualified: p.qualified });

// ---------------------------------------------------------------- チーム成績

function teamStats(db, settings, season) {
  const data = collect(db, settings, season);
  const results = data.games.map((g) => ({
    id: g.id,
    date: g.date,
    opponent: g.opponent,
    kind: g.kind,
    our: g.our_score,
    their: g.their_score,
    result: gameResult(g),
  }));
  const count = (r) => results.filter((x) => x.result === r).length;
  const w = count("win");
  const l = count("lose");
  const d = count("draw");
  const runs = results.reduce((s, x) => s + (Number(x.our) || 0), 0);
  const allowed = results.reduce((s, x) => s + (Number(x.their) || 0), 0);
  const bt = battingTotals(data.batRows);
  const br = battingRates(bt);
  const pt = pitchingTotals(data.pitRows);
  const pr = pitchingRates(pt, data.qualify.innings);
  // 現在の連勝・連敗
  let streak = null;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i].result;
    if (!r) continue;
    if (!streak) streak = { result: r, n: 1 };
    else if (streak.result === r) streak.n++;
    else break;
  }
  return {
    season: seasonLabel(season),
    games: results.length,
    w,
    l,
    d,
    winPct: w + l > 0 ? w / (w + l) : null,
    runs,
    allowed,
    runDiff: runs - allowed,
    avg: br.avg,
    obp: br.obp,
    ops: br.ops,
    era: pr.era,
    hr: bt.hr,
    sb: bt.sb,
    so: pt.so,
    streak,
    recent: results.slice(-5).reverse(),
    results,
  };
}

// ---------------------------------------------------------------- 選手ページ

function batLine(b) {
  const parts = [];
  if (b.ab > 0) parts.push(`${b.ab}打数${b.h}安打`);
  else parts.push(`${b.pa}打席`);
  if (b.hr) parts.push(`${b.hr}本塁打`);
  else if (b.d3) parts.push(`三塁打${b.d3}`);
  else if (b.d2) parts.push(`二塁打${b.d2}`);
  if (b.rbi) parts.push(`${b.rbi}打点`);
  if (b.sb) parts.push(`${b.sb}盗塁`);
  if (b.bb + b.hbp) parts.push(`四死球${b.bb + b.hbp}`);
  return parts.join(" ");
}

const DECISION = { W: "勝利投手", L: "敗戦投手", S: "セーブ", H: "ホールド" };
function pitLine(p) {
  const parts = [`${fmtIP(p.outs)}回`, `${p.r}失点`];
  if (p.so) parts.push(`${p.so}奪三振`);
  if (p.decision && DECISION[p.decision]) parts.push(DECISION[p.decision]);
  return parts.join(" ");
}

function formOf(batRows) {
  const last = batRows.slice(-5);
  if (!last.length) return null;
  const t = battingTotals(last);
  const avg = t.ab > 0 ? t.h / t.ab : null;
  let label = "まずまず";
  let icon = "⛅";
  if (avg === null) [label, icon] = ["様子見", "🌙"];
  else if (avg >= 0.4 || t.hr >= 2) [label, icon] = ["絶好調", "🔥"];
  else if (avg >= 0.3) [label, icon] = ["好調", "☀️"];
  else if (avg < 0.2) [label, icon] = ["スランプ気味", "☔"];
  return {
    label,
    icon,
    avg,
    ab: t.ab,
    h: t.h,
    hr: t.hr,
    rbi: t.rbi,
    games: last.map((b) => ({ gameId: b.game_id, date: b.g_date, ab: b.ab, h: b.h, hr: b.hr, rbi: b.rbi })),
  };
}

function trendOf(batRows) {
  let h = 0;
  let ab = 0;
  const out = [];
  for (const b of batRows) {
    h += b.h;
    ab += b.ab;
    if (ab > 0) out.push({ gameId: b.game_id, date: b.g_date, avg: h / ab, h: b.h, ab: b.ab });
  }
  return out;
}

function playerPage(c) {
  const id = v.int(c.params.id, "選手", { min: 1, required: true });
  const row = c.db.one("SELECT * FROM members WHERE id = ?", id);
  if (!row) throw notFound("選手が見つかりません");
  const member = publicMember(row);
  const members = membersById(c.db);
  const current = Number(c.settings.season);

  const pick = (data) => {
    const b = data.batting.find((p) => p.member.id === id);
    const p = data.pitching.find((p) => p.member.id === id);
    const own = (x) => (x ? { games: x.games, totals: x.totals, rates: x.rates, qualified: x.qualified } : null);
    return { batting: own(b), pitching: own(p), qualify: data.qualify };
  };

  const seasonData = collect(c.db, c.settings, current, members);
  const careerData = collect(c.db, c.settings, null, members);
  const seasons = c.db
    .all("SELECT DISTINCT season FROM games WHERE status = 'final' ORDER BY season DESC")
    .map((r) => r.season);

  const byYear = [];
  const titles = [];
  for (const s of seasons) {
    const data = s === current ? seasonData : collect(c.db, c.settings, s, members);
    const mine = pick(data);
    if (mine.batting || mine.pitching) byYear.push({ season: s, ...mine });
    if (s >= current || member.isGuest) continue;
    for (const t of TITLES) {
      const cat = [...BATTING_CATEGORIES, ...PITCHING_CATEGORIES].find((x) => x.key === t.key);
      const ranked = rankCategory(data[t.side], cat);
      const hit = ranked.find((x) => x.member.id === id && x.rank === 1);
      if (hit) titles.push({ season: s, key: t.key, label: t.label, value: hit.value, type: cat.type });
    }
  }

  // チーム内順位（今季）
  const ranks = [];
  for (const side of ["batting", "pitching"]) {
    const cats = side === "batting" ? BATTING_CATEGORIES : PITCHING_CATEGORIES;
    for (const key of RANK_KEYS[side]) {
      const cat = cats.find((x) => x.key === key);
      const ranked = rankCategory(seasonData[side], cat);
      const hit = ranked.find((x) => x.member.id === id);
      if (hit) ranks.push({ side, key, label: cat.label, type: cat.type, rank: hit.rank, value: hit.value, of: ranked.length });
    }
  }

  // 試合ごとの成績（新しい順）
  const myBat = careerData.batRows.filter((r) => r.member_id === id);
  const myPit = careerData.pitRows.filter((r) => r.member_id === id);
  const batByGame = new Map(myBat.map((r) => [r.game_id, r]));
  const pitByGame = new Map(myPit.map((r) => [r.game_id, r]));
  const gameLog = careerData.games
    .filter((g) => batByGame.has(g.id) || pitByGame.has(g.id))
    .map((g) => {
      const b = batByGame.get(g.id);
      const p = pitByGame.get(g.id);
      return {
        gameId: g.id,
        date: g.date,
        season: g.season,
        opponent: g.opponent,
        kind: g.kind,
        our: g.our_score,
        their: g.their_score,
        result: gameResult(g),
        mvp: g.mvp_member_id === id,
        batting: b ? { ...pickFields(b, BAT_KEYS), line: batLine(b) } : null,
        pitching: p ? { ...pickFields(p, PIT_KEYS), line: pitLine(p) } : null,
      };
    })
    .reverse();

  const seasonBat = myBat.filter((r) => r.g_season === current);
  const trendRows = seasonBat.length >= 2 ? seasonBat : myBat;
  return {
    member,
    season: current,
    current: pick(seasonData),
    career: pick(careerData),
    byYear,
    gameLog,
    form: formOf(seasonBat.length ? seasonBat : myBat),
    trend: { scope: trendRows === seasonBat ? "season" : "career", points: trendOf(trendRows) },
    titles,
    ranks,
    isPitcher: myPit.length > 0 || member.positions.includes("投"),
  };
}

const BAT_KEYS = ["order_no", "position", "pa", "ab", "h", "d2", "d3", "hr", "rbi", "r", "so", "bb", "hbp", "sh", "sf", "sb", "e"];
const PIT_KEYS = ["outs", "bf", "pitches", "h", "hr", "so", "bb", "hbp", "r", "er", "decision"];
const pickFields = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));

// ---------------------------------------------------------------- 開発用ダミーデータ

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DUMMY_PLAYERS = [
  { name: "田中 翔太", number: "1", positions: "遊,二", throws: "右", bats: "左", skill: 0.34, power: 0.08, speed: 0.5 },
  { name: "佐藤 大輔", number: "18", positions: "投,一", throws: "右", bats: "右", skill: 0.27, power: 0.1, speed: 0.1 },
  { name: "鈴木 健太", number: "3", positions: "三", throws: "右", bats: "右", skill: 0.31, power: 0.22, speed: 0.15 },
  { name: "高橋 誠", number: "2", positions: "捕", throws: "右", bats: "右", skill: 0.26, power: 0.12, speed: 0.05 },
  { name: "伊藤 拓也", number: "8", positions: "中,左", throws: "左", bats: "左", skill: 0.33, power: 0.06, speed: 0.6 },
  { name: "渡辺 隼人", number: "25", positions: "一,DH", throws: "左", bats: "左", skill: 0.29, power: 0.26, speed: 0.05 },
  { name: "山本 亮", number: "11", positions: "投,右", throws: "左", bats: "左", skill: 0.25, power: 0.07, speed: 0.2 },
  { name: "中村 優太", number: "6", positions: "二", throws: "右", bats: "両", skill: 0.28, power: 0.04, speed: 0.45 },
  { name: "小林 達也", number: "9", positions: "右,投", throws: "右", bats: "右", skill: 0.24, power: 0.15, speed: 0.25 },
  { name: "加藤 慎吾", number: "7", positions: "左", throws: "右", bats: "右", skill: 0.22, power: 0.05, speed: 0.3 },
  { name: "助っ人 吉田", number: "99", positions: "右,左", throws: "右", bats: "右", skill: 0.3, power: 0.1, speed: 0.3, guest: true },
];
const OPPONENTS = ["川口ファイターズ", "浦和レッドソックス", "大宮キングス", "所沢ブルーウェーブ", "越谷ドラゴンズ", "草加サンダース", "戸田マリナーズ", "朝霞ベアーズ", "春日部タイガース", "上尾イーグルス"];

function devSeed(c) {
  if (c.env?.ALLOW_MOCK !== "true") throw notFound("APIが見つかりません");
  if (!c.user) throw new ApiError(401, "login_required", "LINEログインが必要です");
  if (!c.member) throw new ApiError(403, "not_member", "先にチームに参加してください");
  if (!c.isAdmin) throw forbidden("管理者だけが操作できます");
  const games = v.int(c.body.games, "試合数", { min: 1, max: 30 }) ?? 8;
  const rnd = mulberry32(Number(c.body.seed) || 20261011);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const randInt = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const now = c.now.ts;
  const season = Number(c.settings.season);
  const SEED_MEMO = "[dev-seed]";

  return c.db.tx(() => {
    // 以前のダミー試合を消して作り直す
    const old = c.db.all("SELECT id FROM games WHERE memo = ?", SEED_MEMO).map((r) => r.id);
    for (const gid of old) {
      c.db.run("DELETE FROM batting WHERE game_id = ?", gid);
      c.db.run("DELETE FROM pitching WHERE game_id = ?", gid);
      c.db.run("DELETE FROM games_at_bats WHERE game_id = ?", gid);
      c.db.run("DELETE FROM games WHERE id = ?", gid);
    }
    // 選手: 在籍メンバー＋ダミー選手（名前が同じなら再利用）
    const roster = [];
    for (const m of c.db.all("SELECT * FROM members WHERE active = 1 AND line_user_id IS NOT NULL")) {
      roster.push({ id: m.id, skill: 0.24 + rnd() * 0.12, power: 0.05 + rnd() * 0.15, speed: rnd() * 0.5, pitcher: (m.positions || "").includes("投") });
    }
    for (const d of DUMMY_PLAYERS) {
      let m = c.db.one("SELECT * FROM members WHERE name = ? AND line_user_id IS NULL", d.name);
      if (!m) {
        const { lastId } = c.db.run(
          "INSERT INTO members(name, number, positions, throws, bats, is_guest, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
          d.name, d.number, d.positions, d.throws, d.bats, d.guest ? 1 : 0, now,
        );
        m = { id: lastId };
      }
      roster.push({ id: m.id, ...d, pitcher: d.positions.includes("投") });
    }
    const pitchers = roster.filter((p) => p.pitcher);
    if (pitchers.length < 2) pitchers.push(...roster.filter((p) => !p.pitcher).slice(0, 2 - pitchers.length));

    const plan = [];
    // 今季 games 試合 + 昨季 6 試合（年度別・タイトル表示用）+ 入力中 1 試合（集計に含まれないこと確認用）
    for (let i = 0; i < games; i++) plan.push({ season, date: seasonDate(season, i, games), status: "final" });
    for (let i = 0; i < 6; i++) plan.push({ season: season - 1, date: seasonDate(season - 1, i, 6), status: "final" });
    plan.push({ season, date: c.now.date, status: "draft" });

    let created = 0;
    for (const g of plan) {
      const innings = Number(c.settings.inningsPerGame) || 7;
      const lineup = shuffle(roster, rnd).slice(0, Math.min(roster.length, randInt(9, 11)));
      const bat = lineup.map((p, i) => simulateBatter(p, i + 1, rnd));
      const ourScore = bat.reduce((s, b) => s + b.r, 0);
      const theirScore = Math.max(0, Math.round(rnd() * 9 + (rnd() < 0.35 ? 3 : 0) - 1));
      // 投手: 先発 + 必要ならリリーフ
      const starter = pick(pitchers);
      const totalOuts = innings * 3;
      const sOuts = Math.min(totalOuts, randInt(12, totalOuts));
      const staff = [{ p: starter, outs: sOuts }];
      if (sOuts < totalOuts) {
        const rel = pitchers.find((x) => x !== starter) || roster.find((x) => x !== starter);
        staff.push({ p: rel, outs: totalOuts - sOuts });
      }
      let left = theirScore;
      const pit = staff.map((s, i) => {
        const r = i === staff.length - 1 ? left : Math.min(left, Math.round((theirScore * s.outs) / totalOuts + (rnd() - 0.5)));
        left -= r;
        const er = Math.max(0, r - (rnd() < 0.4 ? randInt(0, Math.min(2, r)) : 0));
        const ip = s.outs / 3;
        const h = Math.max(r - 1, Math.round(ip * (0.6 + rnd() * 0.8)));
        const bb = Math.round(ip * rnd() * 0.7);
        const so = Math.round(ip * (0.5 + rnd() * 1.1));
        const hbp = rnd() < 0.2 ? 1 : 0;
        return { member_id: s.p.id, order_no: i + 1, outs: s.outs, r, er, h, bb, so, hbp, hr: rnd() < 0.15 ? 1 : 0, bf: s.outs + h + bb + hbp, pitches: Math.round((s.outs + h + bb) * 4.2), decision: null };
      });
      if (ourScore > theirScore) {
        const winner = pit[0].outs >= 12 ? pit[0] : pit[pit.length - 1];
        winner.decision = "W";
        if (pit.length > 1 && winner === pit[0] && ourScore - theirScore <= 3) pit[pit.length - 1].decision = "S";
      } else if (ourScore < theirScore) {
        pit.reduce((a, b) => (b.r > a.r ? b : a)).decision = "L";
      }
      const lineUs = splitRuns(ourScore, innings, rnd);
      const lineThem = splitRuns(theirScore, innings, rnd);
      const { lastId: gid } = c.db.run(
        `INSERT INTO games(season, date, opponent, venue, kind, innings, bat_first, our_score, their_score, line_us, line_them, status, memo, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        g.season, g.date, pick(OPPONENTS), pick(["河川敷グラウンド", "市民球場", "中央公園野球場"]), pick(["league", "friendly", "friendly", "tournament"]),
        innings, rnd() < 0.5 ? 1 : 0, ourScore, theirScore, JSON.stringify(lineUs), JSON.stringify(lineThem), g.status, SEED_MEMO, now, now,
      );
      for (const b of bat) {
        c.db.run(
          `INSERT INTO batting(game_id, member_id, order_no, position, pa, ab, h, d2, d3, hr, rbi, r, so, bb, hbp, sh, sf, sb, e, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          gid, b.member_id, b.order_no, null, b.pa, b.ab, b.h, b.d2, b.d3, b.hr, b.rbi, b.r, b.so, b.bb, b.hbp, b.sh, b.sf, b.sb, b.e, now,
        );
      }
      for (const p of pit) {
        c.db.run(
          `INSERT INTO pitching(game_id, member_id, order_no, outs, bf, pitches, h, hr, so, bb, hbp, r, er, decision, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          gid, p.member_id, p.order_no, p.outs, p.bf, p.pitches, p.h, p.hr, p.so, p.bb, p.hbp, p.r, p.er, p.decision, now,
        );
      }
      created++;
    }
    return { ok: true, games: created };
  });
}

function seasonDate(season, i, n) {
  // 4月〜10月に均等に並べる（今季は今日より前に収める）
  const start = Date.UTC(season, 3, 5);
  const end = Date.UTC(season, 9, 4);
  const t = new Date(start + ((end - start) * i) / Math.max(1, n));
  const day = t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + ((7 - day) % 7)); // 日曜に寄せる
  return t.toISOString().slice(0, 10);
}

function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function splitRuns(total, innings, rnd) {
  const line = Array(innings).fill(0);
  for (let i = 0; i < total; i++) line[Math.floor(rnd() * innings)]++;
  return line;
}

function simulateBatter(p, order, rnd) {
  const b = { member_id: p.id, order_no: order, pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, r: 0, so: 0, bb: 0, hbp: 0, sh: 0, sf: 0, sb: 0, e: 0 };
  const pa = order <= 4 ? (rnd() < 0.6 ? 4 : 3) : rnd() < 0.3 ? 4 : 3;
  for (let i = 0; i < pa; i++) {
    b.pa++;
    const x = rnd();
    if (x < 0.1) b.bb++;
    else if (x < 0.13) b.hbp++;
    else if (x < 0.15) b.sh++;
    else if (x < 0.17) {
      b.sf++;
      b.rbi++;
    } else {
      b.ab++;
      if (rnd() < p.skill) {
        b.h++;
        const y = rnd();
        if (y < p.power * 0.7) {
          b.hr++;
          b.r++;
          b.rbi += 1 + (rnd() < 0.5 ? Math.floor(rnd() * 3) : 0);
          continue;
        } else if (y < p.power * 0.7 + 0.04) b.d3++;
        else if (y < p.power + 0.18) b.d2++;
        if (rnd() < 0.35) b.rbi++;
        if (rnd() < 0.45) b.r++;
        if (rnd() < p.speed * 0.5) b.sb++;
      } else if (rnd() < 0.3) b.so++;
    }
    if (x < 0.13 && rnd() < 0.3) {
      b.r++;
      if (rnd() < p.speed) b.sb++;
    }
  }
  if (rnd() < 0.06) b.e++;
  return b;
}

// ---------------------------------------------------------------- ルート

export default {
  name: "stats",
  migrations: [],
  routes: [
    [
      "GET",
      "/stats/batting",
      (c) => {
        const season = parseSeason(c);
        const data = collect(c.db, c.settings, season);
        return { season: seasonLabel(season), qualify: data.qualify, players: data.batting.map(strip) };
      },
    ],
    [
      "GET",
      "/stats/pitching",
      (c) => {
        const season = parseSeason(c);
        const data = collect(c.db, c.settings, season);
        return { season: seasonLabel(season), qualify: data.qualify, players: data.pitching.map(strip) };
      },
    ],
    [
      "GET",
      "/stats/leaders",
      (c) => {
        const season = parseSeason(c);
        const data = collect(c.db, c.settings, season);
        return { season: seasonLabel(season), qualify: data.qualify, ...leaders(data, c.member?.id) };
      },
    ],
    ["GET", "/stats/team", (c) => teamStats(c.db, c.settings, parseSeason(c))],
    [
      "GET",
      "/stats/seasons",
      (c) => {
        const seasons = c.db
          .all("SELECT DISTINCT season FROM games WHERE status = 'final' ORDER BY season DESC")
          .map((r) => r.season);
        const current = Number(c.settings.season);
        if (!seasons.includes(current)) seasons.unshift(current);
        seasons.sort((a, b) => b - a);
        return { seasons, current };
      },
    ],
    ["GET", "/stats/players/:id", playerPage],
    ["POST", "/stats/dev-seed", devSeed, { auth: "public" }],
  ],
};
