// 試合結果・スコア・スタメン・打撃/投手成績の入力（games 機能）
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";
import { BATTING_FIELDS, PITCHING_FIELDS, gameResult, validateBatting } from "../../../public/app/lib/stats.js";

const BAT_LABEL = Object.fromEntries(BATTING_FIELDS);
const PITCH_LABEL = { ...Object.fromEntries(PITCHING_FIELDS), outs: "投球回" };

const KINDS = ["league", "tournament", "friendly"];
const POSITIONS = ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", "DH", "控え"];
const DECISIONS = ["W", "L", "S", "H"];
const DECISION_LABEL = { W: "勝利投手", L: "敗戦投手", S: "セーブ", H: "ホールド" };

// 1打席の結果 → 打撃成績への加算（public/app/features/games.js の AT_BAT と同じ定義）
export const AT_BAT = {
  "1B": { pa: 1, ab: 1, h: 1 },
  "2B": { pa: 1, ab: 1, h: 1, d2: 1 },
  "3B": { pa: 1, ab: 1, h: 1, d3: 1 },
  HR: { pa: 1, ab: 1, h: 1, hr: 1 },
  BB: { pa: 1, bb: 1 },
  HBP: { pa: 1, hbp: 1 },
  SO: { pa: 1, ab: 1, so: 1 },
  GO: { pa: 1, ab: 1 },
  FO: { pa: 1, ab: 1 },
  DP: { pa: 1, ab: 1 },
  SH: { pa: 1, sh: 1 },
  SF: { pa: 1, sf: 1 },
  E: { pa: 1, ab: 1 },
  FC: { pa: 1, ab: 1 },
};
const COUNT_KEYS = ["pa", "ab", "h", "d2", "d3", "hr", "so", "bb", "hbp", "sh", "sf"];
const EXTRA_KEYS = ["rbi", "r", "sb", "e"];
const PITCH_KEYS = ["outs", "bf", "pitches", "h", "hr", "so", "bb", "hbp", "r", "er"];

export function countAtBats(list) {
  const t = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const code of list) for (const [k, n] of Object.entries(AT_BAT[code] || {})) t[k] += n;
  return t;
}

// ---------------------------------------------------------------- helpers
const parseLine = (s) => {
  if (!s) return null;
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
};

function view(g) {
  return { ...g, line_us: parseLine(g.line_us), line_them: parseLine(g.line_them), result: gameResult(g) };
}

function getGame(db, id) {
  const g = db.one("SELECT * FROM games WHERE id = ?", Number(id));
  if (!g) throw notFound("試合が見つかりません");
  return g;
}

function getMember(db, id) {
  const m = db.one("SELECT * FROM members WHERE id = ?", Number(id));
  if (!m) throw notFound("メンバーが見つかりません");
  return m;
}

// 本人 or 管理者。確定済みの試合は管理者だけ
function requireEditable(c, game, memberId) {
  c.requireAdminOrSelf(memberId);
  if (game.status === "final" && !c.isAdmin) throw forbidden("確定済みの試合は管理者だけが編集できます");
}

const touch = (c, id) => c.db.run("UPDATE games SET updated_at = ? WHERE id = ?", c.now.ts, id);

// 出場者: スタメン（打順 or 守備位置あり。控えは除く）＋ 投手・入力済みの人。スタメン未登録なら紐づく予定の出席者（yes）
function participants(db, game) {
  const lineup = db.all(
    "SELECT member_id FROM batting WHERE game_id = ? AND (order_no IS NOT NULL OR (position IS NOT NULL AND position != '控え'))",
    game.id,
  );
  const ids = new Set(lineup.map((r) => r.member_id));
  for (const r of db.all("SELECT member_id FROM pitching WHERE game_id = ?", game.id)) ids.add(r.member_id);
  for (const r of db.all("SELECT member_id FROM batting WHERE game_id = ? AND pa > 0", game.id)) ids.add(r.member_id);
  if (!lineup.length && game.event_id) {
    for (const r of db.all("SELECT member_id FROM attendance WHERE event_id = ? AND status = 'yes'", game.event_id)) {
      ids.add(r.member_id);
    }
  }
  return ids;
}

// 出場者のうち成績未入力（打席 0 かつ 投手成績なし）の人
function pendingIds(db, game) {
  const done = new Set(db.all("SELECT member_id FROM batting WHERE game_id = ? AND pa > 0", game.id).map((r) => r.member_id));
  for (const r of db.all("SELECT member_id FROM pitching WHERE game_id = ?", game.id)) done.add(r.member_id);
  return [...participants(db, game)].filter((id) => !done.has(id));
}

function membersByIds(db, ids) {
  if (!ids.length) return [];
  return db
    .all(`SELECT * FROM members WHERE id IN (${ids.map(() => "?").join(",")}) AND active = 1`, ...ids)
    .map(publicMember);
}

function seasonSummary(rows) {
  const s = { games: 0, win: 0, lose: 0, draw: 0, runs: 0, allowed: 0, winPct: null };
  for (const g of rows) {
    const r = gameResult(g);
    if (!r) continue;
    s.games++;
    s[r]++;
    s.runs += g.our_score;
    s.allowed += g.their_score;
  }
  s.winPct = s.win + s.lose > 0 ? s.win / (s.win + s.lose) : null;
  return s;
}

function intField(val, label, opts = {}) {
  return v.int(val, label, { min: 0, max: 99, ...opts }) ?? 0;
}

function gameFields(c, body, { creating = false } = {}) {
  const f = {};
  if (creating || body.date !== undefined) f.date = v.date(body.date, "日付", { required: true });
  if (creating || body.opponent !== undefined) f.opponent = v.str(body.opponent, "対戦相手", { max: 40, required: true });
  if (body.venue !== undefined) f.venue = v.str(body.venue, "球場", { max: 60 });
  if (creating || body.kind !== undefined) f.kind = v.oneOf(body.kind || "friendly", "種別", KINDS, { required: true });
  if (creating || body.innings !== undefined) {
    f.innings = v.int(body.innings ?? c.settings.inningsPerGame ?? 7, "イニング", { min: 1, max: 15, required: true });
  }
  if (creating || body.batFirst !== undefined) f.bat_first = body.batFirst === false || body.batFirst === 0 || body.batFirst === "0" ? 0 : 1;
  if (body.memo !== undefined) f.memo = v.str(body.memo, "メモ", { max: 1000 });
  if (body.mvpMemberId !== undefined) {
    f.mvp_member_id = v.int(body.mvpMemberId, "MVP", { min: 1, max: 1e9 });
    if (f.mvp_member_id) getMember(c.db, f.mvp_member_id);
  }
  if (f.date) f.season = Number(f.date.slice(0, 4));
  return f;
}

function updateGame(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
}

function parseScoreLine(arr, label) {
  if (arr === undefined || arr === null) return null;
  if (!Array.isArray(arr)) throw badRequest(`${label}の形式が不正です`);
  if (arr.length > 20) throw badRequest("イニングは20回までです");
  const out = arr.map((x) => (x === null || x === "" || x === undefined ? null : v.int(x, `${label}の得点`, { max: 99 })));
  while (out.length && out[out.length - 1] === null) out.pop();
  return out.length ? out : null;
}

const sumLine = (line) => line.reduce((a, b) => a + (b || 0), 0);

function battingRow(db, gameId, memberId) {
  return db.one("SELECT * FROM batting WHERE game_id = ? AND member_id = ?", gameId, memberId);
}

function atBatsOf(db, gameId, memberId) {
  return db
    .all("SELECT result FROM games_at_bats WHERE game_id = ? AND member_id = ? ORDER BY seq", gameId, memberId)
    .map((r) => r.result);
}

// ---------------------------------------------------------------- handlers
function listGames(c) {
  const season = v.int(c.query.season, "年度", { min: 2000, max: 2100 }) ?? c.settings.season;
  const rows = c.db.all("SELECT * FROM games WHERE season = ? ORDER BY date DESC, id DESC", season);
  const seasons = new Set(c.db.all("SELECT DISTINCT season FROM games").map((r) => r.season));
  seasons.add(Number(c.settings.season));
  seasons.add(c.now.year);
  const mine = new Set(
    c.db.all("SELECT game_id FROM batting WHERE member_id = ? AND pa > 0", c.member.id).map((r) => r.game_id),
  );
  return {
    season,
    seasons: [...seasons].sort((a, b) => b - a),
    summary: seasonSummary(rows),
    games: rows.map((g) => ({ ...view(g), recorded: mine.has(g.id) })),
  };
}

function candidates(c) {
  const rows = c.db.all(
    `SELECT e.* FROM events e
     WHERE e.type = 'game' AND e.status != 'canceled'
       AND NOT EXISTS (SELECT 1 FROM games g WHERE g.event_id = e.id)
       AND e.date >= date(?, '-120 days') AND e.date <= date(?, '+14 days')
     ORDER BY ABS(julianday(e.date) - julianday(?)), e.date DESC LIMIT 10`,
    c.now.date,
    c.now.date,
    c.now.date,
  );
  return {
    events: rows.map((e) => ({ id: e.id, title: e.title, date: e.date, opponent: e.opponent, venue: e.venue, start_time: e.start_time })),
  };
}

function createGame(c) {
  const b = { ...c.body };
  let eventId = null;
  if (b.eventId !== undefined && b.eventId !== null && b.eventId !== "") {
    eventId = v.int(b.eventId, "予定", { min: 1, max: 1e9 });
    const ev = c.db.one("SELECT * FROM events WHERE id = ?", eventId);
    if (!ev) throw notFound("予定が見つかりません");
    if (c.db.one("SELECT id FROM games WHERE event_id = ?", eventId)) throw conflict("この予定の試合はすでに作成されています");
    b.date ??= ev.date;
    b.opponent ??= ev.opponent || ev.title;
    if (b.venue === undefined) b.venue = ev.venue;
  }
  const f = gameFields(c, b, { creating: true });
  const { lastId } = c.db.run(
    `INSERT INTO games(event_id, season, date, opponent, venue, kind, innings, bat_first, memo, status, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    eventId,
    f.season,
    f.date,
    f.opponent,
    f.venue ?? null,
    f.kind,
    f.innings,
    f.bat_first,
    f.memo ?? null,
    c.now.ts,
    c.now.ts,
  );
  return { game: view(getGame(c.db, lastId)) };
}

function gameDetail(c) {
  const g = getGame(c.db, c.params.id);
  const memberRows = new Map(c.db.all("SELECT * FROM members").map((m) => [m.id, m]));
  const pm = (id) => publicMember(memberRows.get(id));
  const batting = c.db
    .all(
      `SELECT * FROM batting WHERE game_id = ?
       ORDER BY CASE WHEN order_no IS NULL THEN 1 ELSE 0 END, order_no, CASE WHEN pa > 0 THEN 0 ELSE 1 END, member_id`,
      g.id,
    )
    .map((r) => ({ ...r, member: pm(r.member_id) }));
  const pitching = c.db
    .all("SELECT * FROM pitching WHERE game_id = ? ORDER BY order_no, member_id", g.id)
    .map((r) => ({ ...r, member: pm(r.member_id) }));
  const atBats = {};
  for (const r of c.db.all("SELECT member_id, result FROM games_at_bats WHERE game_id = ? ORDER BY member_id, seq", g.id)) {
    (atBats[r.member_id] ??= []).push(r.result);
  }
  const event = g.event_id ? c.db.one("SELECT id, title, date, start_time, venue FROM events WHERE id = ?", g.event_id) : null;
  const ids = [...participants(c.db, g)];
  return {
    game: view(g),
    batting,
    pitching,
    atBats,
    event,
    mvp: g.mvp_member_id ? pm(g.mvp_member_id) : null,
    participants: membersByIds(c.db, ids),
    pending: membersByIds(c.db, pendingIds(c.db, g)),
    teamName: c.settings.teamName,
  };
}

function patchGame(c) {
  const g = getGame(c.db, c.params.id);
  updateGame(c.db, g.id, gameFields(c, c.body));
  touch(c, g.id);
  return { game: view(getGame(c.db, g.id)) };
}

function deleteGame(c) {
  const g = getGame(c.db, c.params.id);
  c.db.tx(() => {
    for (const t of ["batting", "pitching", "games_at_bats"]) c.db.run(`DELETE FROM ${t} WHERE game_id = ?`, g.id);
    c.db.run("DELETE FROM games WHERE id = ?", g.id);
  });
  return { ok: true };
}

function putScore(c) {
  const g = getGame(c.db, c.params.id);
  const lineUs = parseScoreLine(c.body.lineUs, "自チーム");
  const lineThem = parseScoreLine(c.body.lineThem, "相手チーム");
  const ours = lineUs ? sumLine(lineUs) : v.int(c.body.ourScore, "自チームの得点", { max: 999 });
  const theirs = lineThem ? sumLine(lineThem) : v.int(c.body.theirScore, "相手チームの得点", { max: 999 });
  updateGame(c.db, g.id, {
    line_us: lineUs ? JSON.stringify(lineUs) : null,
    line_them: lineThem ? JSON.stringify(lineThem) : null,
    our_score: ours,
    their_score: theirs,
    updated_at: c.now.ts,
  });
  return { game: view(getGame(c.db, g.id)) };
}

function getLineup(c) {
  const g = getGame(c.db, c.params.id);
  const rows = c.db.all("SELECT * FROM batting WHERE game_id = ?", g.id);
  const att = new Map(
    g.event_id ? c.db.all("SELECT member_id, status FROM attendance WHERE event_id = ?", g.event_id).map((r) => [r.member_id, r.status]) : [],
  );
  const members = c.db.all(
    `SELECT * FROM members WHERE active = 1
     ORDER BY is_guest, CASE WHEN number GLOB '[0-9]*' THEN CAST(number AS INTEGER) ELSE 9999 END, id`,
  );
  const rank = { yes: 0, maybe: 1, none: 2, no: 3 };
  const candidates = members
    .map((m) => ({ member: publicMember(m), attendance: att.get(m.id) || null }))
    .sort((a, b) => (rank[a.attendance ?? "none"] ?? 2) - (rank[b.attendance ?? "none"] ?? 2));
  const lineup = rows
    .filter((r) => r.order_no !== null || r.position !== null)
    .sort((a, b) => (a.order_no ?? 999) - (b.order_no ?? 999))
    .map((r) => ({ memberId: r.member_id, orderNo: r.order_no, position: r.position }));
  return { game: view(g), lineup, candidates, teamName: c.settings.teamName };
}

function putLineup(c) {
  const g = getGame(c.db, c.params.id);
  const list = c.body.lineup;
  if (!Array.isArray(list)) throw badRequest("スタメンの形式が不正です");
  if (list.length > 40) throw badRequest("人数が多すぎます");
  const seenMember = new Set();
  const seenOrder = new Set();
  const clean = list.map((x) => {
    const memberId = v.int(x?.memberId, "選手", { min: 1, max: 1e9, required: true });
    getMember(c.db, memberId);
    if (seenMember.has(memberId)) throw badRequest("同じ選手が2回入っています");
    seenMember.add(memberId);
    const orderNo = v.int(x.orderNo, "打順", { min: 1, max: 30 });
    if (orderNo !== null) {
      if (seenOrder.has(orderNo)) throw badRequest(`打順${orderNo}番が重複しています`);
      seenOrder.add(orderNo);
    }
    const position = v.oneOf(x.position, "守備位置", POSITIONS);
    return { memberId, orderNo, position };
  });
  c.db.tx(() => {
    // 外れた選手: 成績が無ければ行ごと削除、あれば打順・守備だけ外す
    for (const r of c.db.all("SELECT * FROM batting WHERE game_id = ?", g.id)) {
      if (seenMember.has(r.member_id)) continue;
      const hasStats = [...COUNT_KEYS, ...EXTRA_KEYS].some((k) => r[k] > 0);
      if (hasStats) c.db.run("UPDATE batting SET order_no = NULL, position = NULL WHERE game_id = ? AND member_id = ?", g.id, r.member_id);
      else c.db.run("DELETE FROM batting WHERE game_id = ? AND member_id = ?", g.id, r.member_id);
    }
    for (const x of clean) {
      c.db.run(
        `INSERT INTO batting(game_id, member_id, order_no, position, updated_by, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, member_id) DO UPDATE SET order_no = excluded.order_no, position = excluded.position`,
        g.id,
        x.memberId,
        x.orderNo,
        x.position,
        c.member.id,
        c.now.ts,
      );
    }
    touch(c, g.id);
  });
  return getLineup(c);
}

function getRecord(c) {
  const g = getGame(c.db, c.params.id);
  const m = getMember(c.db, c.params.memberId);
  return {
    game: view(g),
    member: publicMember(m),
    batting: battingRow(c.db, g.id, m.id),
    atBats: atBatsOf(c.db, g.id, m.id),
    pitching: c.db.one("SELECT * FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id),
    canEdit: (c.isAdmin || c.member.id === m.id) && (g.status !== "final" || c.isAdmin),
  };
}

function putBatting(c) {
  const g = getGame(c.db, c.params.id);
  const m = getMember(c.db, c.params.memberId);
  requireEditable(c, g, m.id);
  const b = c.body;
  let counts;
  let atBats = null;
  if (Array.isArray(b.atBats)) {
    if (b.atBats.length > 15) throw badRequest("打席数が多すぎます");
    atBats = b.atBats.map((x) => v.oneOf(x, "打席結果", Object.keys(AT_BAT), { required: true }));
    counts = countAtBats(atBats);
  } else {
    counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, intField(b[k], BAT_LABEL[k])]));
  }
  const extra = Object.fromEntries(EXTRA_KEYS.map((k) => [k, intField(b[k], BAT_LABEL[k])]));
  const row = { ...counts, ...extra };
  const errs = validateBatting(row);
  if (errs.length) throw badRequest(errs.join("\n"), "inconsistent");
  c.db.tx(() => {
    const keys = Object.keys(row);
    c.db.run(
      `INSERT INTO batting(game_id, member_id, ${keys.join(", ")}, updated_by, updated_at)
       VALUES(?, ?, ${keys.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT(game_id, member_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")},
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      g.id,
      m.id,
      ...keys.map((k) => row[k]),
      c.member.id,
      c.now.ts,
    );
    c.db.run("DELETE FROM games_at_bats WHERE game_id = ? AND member_id = ?", g.id, m.id);
    (atBats || []).forEach((r, i) =>
      c.db.run("INSERT INTO games_at_bats(game_id, member_id, seq, result) VALUES(?, ?, ?, ?)", g.id, m.id, i + 1, r),
    );
    touch(c, g.id);
  });
  return { batting: battingRow(c.db, g.id, m.id), atBats: atBats || [] };
}

function putPitching(c) {
  const g = getGame(c.db, c.params.id);
  const m = getMember(c.db, c.params.memberId);
  requireEditable(c, g, m.id);
  const b = c.body;
  const row = {};
  for (const k of PITCH_KEYS) row[k] = intField(b[k], PITCH_LABEL[k], { max: k === "pitches" ? 400 : 99 });
  const decision = v.oneOf(b.decision || null, "勝敗", DECISIONS);
  const errs = [];
  if (row.er > row.r) errs.push("自責点が失点より多くなっています");
  if (row.hr > row.h) errs.push("被本塁打が被安打より多くなっています");
  if (row.bf > 0 && row.h + row.bb + row.hbp + row.so > row.bf) errs.push("被安打・四死球・奪三振の合計が打者数を超えています");
  if (row.bf > 0 && row.pitches > 0 && row.pitches < row.bf) errs.push("球数が打者数より少なくなっています");
  if (errs.length) throw badRequest(errs.join("\n"), "inconsistent");
  if (decision === "W" || decision === "L") {
    const other = c.db.one(
      "SELECT p.member_id, m.name FROM pitching p JOIN members m ON m.id = p.member_id WHERE p.game_id = ? AND p.decision = ? AND p.member_id != ?",
      g.id,
      decision,
      m.id,
    );
    if (other) throw badRequest(`${DECISION_LABEL[decision]}はすでに${other.name}さんになっています`);
  }
  const existing = c.db.one("SELECT order_no FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id);
  const orderNo = existing ? existing.order_no : (c.db.one("SELECT MAX(order_no) AS n FROM pitching WHERE game_id = ?", g.id).n || 0) + 1;
  const keys = [...PITCH_KEYS, "decision"];
  row.decision = decision;
  c.db.run(
    `INSERT INTO pitching(game_id, member_id, order_no, ${keys.join(", ")}, updated_by, updated_at)
     VALUES(?, ?, ?, ${keys.map(() => "?").join(", ")}, ?, ?)
     ON CONFLICT(game_id, member_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")},
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    g.id,
    m.id,
    orderNo,
    ...keys.map((k) => row[k]),
    c.member.id,
    c.now.ts,
  );
  touch(c, g.id);
  return { pitching: c.db.one("SELECT * FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id) };
}

function deletePitching(c) {
  const g = getGame(c.db, c.params.id);
  const m = getMember(c.db, c.params.memberId);
  requireEditable(c, g, m.id);
  c.db.run("DELETE FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id);
  touch(c, g.id);
  return { ok: true };
}

function finalize(c) {
  const g = getGame(c.db, c.params.id);
  if (g.our_score === null || g.their_score === null) throw badRequest("先にスコアを入力してください");
  const mvp = v.int(c.body.mvpMemberId, "MVP", { min: 1, max: 1e9 });
  if (mvp) getMember(c.db, mvp);
  const wasDraft = g.status !== "final";
  updateGame(c.db, g.id, { status: "final", mvp_member_id: mvp ?? g.mvp_member_id, updated_at: c.now.ts });
  const row = getGame(c.db, g.id);
  if (wasDraft) c.emit("game.finalized", { game: row });
  return { game: view(row) };
}

function reopen(c) {
  const g = getGame(c.db, c.params.id);
  updateGame(c.db, g.id, { status: "draft", updated_at: c.now.ts });
  return { game: view(getGame(c.db, g.id)) };
}

// 自分が出場して成績未入力の試合（入力中・今日まで・直近60日）
function pending(c) {
  const rows = c.db.all(
    "SELECT * FROM games WHERE status = 'draft' AND date <= ? AND date >= date(?, '-60 days') ORDER BY date DESC",
    c.now.date,
    c.now.date,
  );
  return { games: rows.filter((g) => pendingIds(c.db, g).includes(c.member.id)).map(view) };
}

function latest(c) {
  const g = c.db.one(
    "SELECT * FROM games WHERE our_score IS NOT NULL AND their_score IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1",
  );
  if (!g) return { game: null };
  const hits = c.db.one("SELECT COALESCE(SUM(h), 0) AS h FROM batting WHERE game_id = ?", g.id).h;
  const theirHits = c.db.one("SELECT COALESCE(SUM(h), 0) AS h, COUNT(*) AS n FROM pitching WHERE game_id = ?", g.id);
  const mvp = g.mvp_member_id ? publicMember(c.db.one("SELECT * FROM members WHERE id = ?", g.mvp_member_id)) : null;
  return { game: view(g), hits, theirHits: theirHits.n ? theirHits.h : null, mvp, teamName: c.settings.teamName };
}

export default {
  name: "games",
  migrations: [
    {
      id: "games-001",
      sql: `
-- 1打席ごとの結果（成績入力画面で並びを再編集するため）。result は AT_BAT のキー
CREATE TABLE IF NOT EXISTS games_at_bats (
  game_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (game_id, member_id, seq)
);`,
    },
  ],
  routes: [
    ["GET", "/games", listGames],
    ["GET", "/games/candidates", candidates, { auth: "admin" }],
    ["GET", "/games/pending", pending],
    ["GET", "/games/latest", latest],
    ["POST", "/games", createGame, { auth: "admin" }],
    ["GET", "/games/:id", gameDetail],
    ["PATCH", "/games/:id", patchGame, { auth: "admin" }],
    ["DELETE", "/games/:id", deleteGame, { auth: "admin" }],
    ["PUT", "/games/:id/score", putScore, { auth: "admin" }],
    ["GET", "/games/:id/lineup", getLineup],
    ["PUT", "/games/:id/lineup", putLineup, { auth: "admin" }],
    ["GET", "/games/:id/batting/:memberId", getRecord],
    ["PUT", "/games/:id/batting/:memberId", putBatting],
    ["PUT", "/games/:id/pitching/:memberId", putPitching],
    ["DELETE", "/games/:id/pitching/:memberId", deletePitching],
    ["POST", "/games/:id/finalize", finalize, { auth: "admin" }],
    ["POST", "/games/:id/reopen", reopen, { auth: "admin" }],
  ],
};
