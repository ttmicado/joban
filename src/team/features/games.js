// 試合結果・スコア・スタメン・打撃/投手成績の入力（games 機能）
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { addDays } from "../time.js";
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

async function getGame(db, id) {
  const g = await db.one("SELECT * FROM games WHERE id = ?", Number(id));
  if (!g) throw notFound("試合が見つかりません");
  return g;
}

async function getMember(db, id) {
  const m = await db.one("SELECT * FROM members WHERE id = ?", Number(id));
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
async function participants(db, game) {
  const lineup = await db.all(
    "SELECT member_id FROM batting WHERE game_id = ? AND (order_no IS NOT NULL OR (position IS NOT NULL AND position != '控え'))",
    game.id,
  );
  const ids = new Set(lineup.map((r) => r.member_id));
  for (const r of await db.all("SELECT member_id FROM pitching WHERE game_id = ?", game.id)) ids.add(r.member_id);
  for (const r of await db.all("SELECT member_id FROM batting WHERE game_id = ? AND pa > 0", game.id)) ids.add(r.member_id);
  if (!lineup.length && game.event_id) {
    for (const r of await db.all("SELECT member_id FROM attendance WHERE event_id = ? AND status = 'yes'", game.event_id)) {
      ids.add(r.member_id);
    }
  }
  return ids;
}

// 出場者のうち成績未入力（打席 0 かつ 投手成績なし）の人
async function pendingIds(db, game) {
  const done = new Set((await db.all("SELECT member_id FROM batting WHERE game_id = ? AND pa > 0", game.id)).map((r) => r.member_id));
  for (const r of await db.all("SELECT member_id FROM pitching WHERE game_id = ?", game.id)) done.add(r.member_id);
  return [...(await participants(db, game))].filter((id) => !done.has(id));
}

async function membersByIds(db, ids) {
  if (!ids.length) return [];
  const rows = await db.all(`SELECT * FROM members WHERE id IN (${ids.map(() => "?").join(",")}) AND active = 1`, ...ids);
  return rows.map(publicMember);
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

async function gameFields(c, body, { creating = false } = {}) {
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
    if (f.mvp_member_id) await getMember(c.db, f.mvp_member_id);
  }
  if (f.date) f.season = Number(f.date.slice(0, 4));
  return f;
}

async function updateGame(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
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

async function atBatsOf(db, gameId, memberId) {
  const rows = await db.all("SELECT result FROM games_at_bats WHERE game_id = ? AND member_id = ? ORDER BY seq", gameId, memberId);
  return rows.map((r) => r.result);
}

// ---------------------------------------------------------------- handlers
async function listGames(c) {
  const season = v.int(c.query.season, "年度", { min: 2000, max: 2100 }) ?? c.settings.season;
  const rows = await c.db.all("SELECT * FROM games WHERE season = ? ORDER BY date DESC, id DESC", Number(season));
  const seasons = new Set((await c.db.all("SELECT DISTINCT season FROM games")).map((r) => r.season));
  seasons.add(Number(c.settings.season));
  seasons.add(c.now.year);
  const mine = new Set(
    (await c.db.all("SELECT game_id FROM batting WHERE member_id = ? AND pa > 0", c.member.id)).map((r) => r.game_id),
  );
  return {
    season,
    seasons: [...seasons].sort((a, b) => b - a),
    summary: seasonSummary(rows),
    games: rows.map((g) => ({ ...view(g), recorded: mine.has(g.id) })),
  };
}

async function candidates(c) {
  const rows = await c.db.all(
    `SELECT e.* FROM events e
     WHERE e.type = 'game' AND e.status != 'canceled'
       AND NOT EXISTS (SELECT 1 FROM games g WHERE g.event_id = e.id)
       AND e.date >= ? AND e.date <= ?
     ORDER BY ABS(e.date::date - ?::date), e.date DESC LIMIT 10`,
    addDays(c.now.date, -120),
    addDays(c.now.date, 14),
    c.now.date,
  );
  return {
    events: rows.map((e) => ({ id: e.id, title: e.title, date: e.date, opponent: e.opponent, venue: e.venue, start_time: e.start_time })),
  };
}

async function createGame(c) {
  const b = { ...c.body };
  let eventId = null;
  if (b.eventId !== undefined && b.eventId !== null && b.eventId !== "") {
    eventId = v.int(b.eventId, "予定", { min: 1, max: 1e9 });
    const ev = await c.db.one("SELECT * FROM events WHERE id = ?", eventId);
    if (!ev) throw notFound("予定が見つかりません");
    if (await c.db.one("SELECT id FROM games WHERE event_id = ?", eventId)) throw conflict("この予定の試合はすでに作成されています");
    b.date ??= ev.date;
    // 予定のタイトルは60文字まで入るので、対戦相手の上限（40文字）に収める
    b.opponent ??= (ev.opponent || ev.title || "").slice(0, 40);
    if (b.venue === undefined) b.venue = ev.venue;
  }
  const f = await gameFields(c, b, { creating: true });
  const { lastId } = await c.db.run(
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
  return { game: view(await getGame(c.db, lastId)) };
}

async function gameDetail(c) {
  const g = await getGame(c.db, c.params.id);
  const memberRows = new Map((await c.db.all("SELECT * FROM members")).map((m) => [m.id, m]));
  const pm = (id) => publicMember(memberRows.get(id));
  const batting = (
    await c.db.all(
      `SELECT * FROM batting WHERE game_id = ?
       ORDER BY CASE WHEN order_no IS NULL THEN 1 ELSE 0 END, order_no, CASE WHEN pa > 0 THEN 0 ELSE 1 END, member_id`,
      g.id,
    )
  ).map((r) => ({ ...r, member: pm(r.member_id) }));
  const pitching = (await c.db.all("SELECT * FROM pitching WHERE game_id = ? ORDER BY order_no NULLS FIRST, member_id", g.id)).map(
    (r) => ({ ...r, member: pm(r.member_id) }),
  );
  const atBats = {};
  for (const r of await c.db.all("SELECT member_id, result FROM games_at_bats WHERE game_id = ? ORDER BY member_id, seq", g.id)) {
    (atBats[r.member_id] ??= []).push(r.result);
  }
  const event = g.event_id ? await c.db.one("SELECT id, title, date, start_time, venue FROM events WHERE id = ?", g.event_id) : null;
  const ids = [...(await participants(c.db, g))];
  return {
    game: view(g),
    batting,
    pitching,
    atBats,
    event,
    mvp: g.mvp_member_id ? pm(g.mvp_member_id) : null,
    participants: await membersByIds(c.db, ids),
    pending: await membersByIds(c.db, await pendingIds(c.db, g)),
    teamName: c.settings.teamName,
  };
}

async function patchGame(c) {
  const g = await getGame(c.db, c.params.id);
  await updateGame(c.db, g.id, await gameFields(c, c.body));
  await touch(c, g.id);
  return { game: view(await getGame(c.db, g.id)) };
}

async function deleteGame(c) {
  const g = await getGame(c.db, c.params.id);
  await c.db.tx(async (tx) => {
    for (const t of ["batting", "pitching", "games_at_bats"]) await tx.run(`DELETE FROM ${t} WHERE game_id = ?`, g.id);
    await tx.run("DELETE FROM games WHERE id = ?", g.id);
  });
  return { ok: true };
}

async function putScore(c) {
  const g = await getGame(c.db, c.params.id);
  const lineUs = parseScoreLine(c.body.lineUs, "自チーム");
  const lineThem = parseScoreLine(c.body.lineThem, "相手チーム");
  const ours = lineUs ? sumLine(lineUs) : v.int(c.body.ourScore, "自チームの得点", { max: 999 });
  const theirs = lineThem ? sumLine(lineThem) : v.int(c.body.theirScore, "相手チームの得点", { max: 999 });
  await updateGame(c.db, g.id, {
    line_us: lineUs ? JSON.stringify(lineUs) : null,
    line_them: lineThem ? JSON.stringify(lineThem) : null,
    our_score: ours,
    their_score: theirs,
    updated_at: c.now.ts,
  });
  return { game: view(await getGame(c.db, g.id)) };
}

async function getLineup(c) {
  const g = await getGame(c.db, c.params.id);
  const rows = await c.db.all("SELECT * FROM batting WHERE game_id = ?", g.id);
  const att = new Map(
    g.event_id
      ? (await c.db.all("SELECT member_id, status FROM attendance WHERE event_id = ?", g.event_id)).map((r) => [r.member_id, r.status])
      : [],
  );
  // 背番号は数字だけのものを数値順（members 機能と同じ並び）。桁あふれしないよう 9 桁まで
  const members = await c.db.all(
    `SELECT * FROM members WHERE active = 1
     ORDER BY is_guest, CASE WHEN number ~ '^[0-9]{1,9}$' THEN CAST(number AS BIGINT) ELSE 9999 END, id`,
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

async function putLineup(c) {
  const g = await getGame(c.db, c.params.id);
  const list = c.body.lineup;
  if (!Array.isArray(list)) throw badRequest("スタメンの形式が不正です");
  if (list.length > 40) throw badRequest("人数が多すぎます");
  const seenMember = new Set();
  const seenOrder = new Set();
  const clean = [];
  for (const x of list) {
    const memberId = v.int(x?.memberId, "選手", { min: 1, max: 1e9, required: true });
    await getMember(c.db, memberId);
    if (seenMember.has(memberId)) throw badRequest("同じ選手が2回入っています");
    seenMember.add(memberId);
    const orderNo = v.int(x.orderNo, "打順", { min: 1, max: 30 });
    if (orderNo !== null) {
      if (seenOrder.has(orderNo)) throw badRequest(`打順${orderNo}番が重複しています`);
      seenOrder.add(orderNo);
    }
    const position = v.oneOf(x.position, "守備位置", POSITIONS);
    clean.push({ memberId, orderNo, position });
  }
  await c.db.tx(async (tx) => {
    // 外れた選手: 成績が無ければ行ごと削除、あれば打順・守備だけ外す
    for (const r of await tx.all("SELECT * FROM batting WHERE game_id = ?", g.id)) {
      if (seenMember.has(r.member_id)) continue;
      const hasStats = [...COUNT_KEYS, ...EXTRA_KEYS].some((k) => r[k] > 0);
      if (hasStats) await tx.run("UPDATE batting SET order_no = NULL, position = NULL WHERE game_id = ? AND member_id = ?", g.id, r.member_id);
      else await tx.run("DELETE FROM batting WHERE game_id = ? AND member_id = ?", g.id, r.member_id);
    }
    for (const x of clean) {
      await tx.run(
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
    await touch(c, g.id);
  });
  return getLineup(c);
}

async function getRecord(c) {
  const g = await getGame(c.db, c.params.id);
  const m = await getMember(c.db, c.params.memberId);
  return {
    game: view(g),
    member: publicMember(m),
    batting: await battingRow(c.db, g.id, m.id),
    atBats: await atBatsOf(c.db, g.id, m.id),
    pitching: await c.db.one("SELECT * FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id),
    canEdit: (c.isAdmin || c.member.id === m.id) && (g.status !== "final" || c.isAdmin),
  };
}

async function putBatting(c) {
  const g = await getGame(c.db, c.params.id);
  const m = await getMember(c.db, c.params.memberId);
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
  await c.db.tx(async (tx) => {
    const keys = Object.keys(row);
    await tx.run(
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
    await tx.run("DELETE FROM games_at_bats WHERE game_id = ? AND member_id = ?", g.id, m.id);
    for (const [i, r] of (atBats || []).entries()) {
      await tx.run("INSERT INTO games_at_bats(game_id, member_id, seq, result) VALUES(?, ?, ?, ?)", g.id, m.id, i + 1, r);
    }
    await touch(c, g.id);
  });
  return { batting: await battingRow(c.db, g.id, m.id), atBats: atBats || [] };
}

async function putPitching(c) {
  const g = await getGame(c.db, c.params.id);
  const m = await getMember(c.db, c.params.memberId);
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
    const other = await c.db.one(
      "SELECT p.member_id, m.name FROM pitching p JOIN members m ON m.id = p.member_id WHERE p.game_id = ? AND p.decision = ? AND p.member_id != ?",
      g.id,
      decision,
      m.id,
    );
    if (other) throw badRequest(`${DECISION_LABEL[decision]}はすでに${other.name}さんになっています`);
  }
  const existing = await c.db.one("SELECT order_no FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id);
  const orderNo = existing
    ? existing.order_no
    : ((await c.db.one("SELECT MAX(order_no) AS n FROM pitching WHERE game_id = ?", g.id)).n || 0) + 1;
  const keys = [...PITCH_KEYS, "decision"];
  row.decision = decision;
  await c.db.run(
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
  await touch(c, g.id);
  return { pitching: await c.db.one("SELECT * FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id) };
}

async function deletePitching(c) {
  const g = await getGame(c.db, c.params.id);
  const m = await getMember(c.db, c.params.memberId);
  requireEditable(c, g, m.id);
  await c.db.run("DELETE FROM pitching WHERE game_id = ? AND member_id = ?", g.id, m.id);
  await touch(c, g.id);
  return { ok: true };
}

async function finalize(c) {
  const g = await getGame(c.db, c.params.id);
  if (g.our_score === null || g.their_score === null) throw badRequest("先にスコアを入力してください");
  const mvp = v.int(c.body.mvpMemberId, "MVP", { min: 1, max: 1e9 });
  if (mvp) await getMember(c.db, mvp);
  const wasDraft = g.status !== "final";
  await updateGame(c.db, g.id, { status: "final", mvp_member_id: mvp ?? g.mvp_member_id, updated_at: c.now.ts });
  const row = await getGame(c.db, g.id);
  if (wasDraft) c.emit("game.finalized", { game: row });
  return { game: view(row) };
}

async function reopen(c) {
  const g = await getGame(c.db, c.params.id);
  await updateGame(c.db, g.id, { status: "draft", updated_at: c.now.ts });
  return { game: view(await getGame(c.db, g.id)) };
}

// 自分が出場して成績未入力の試合（入力中・今日まで・直近60日）
async function pending(c) {
  const rows = await c.db.all(
    "SELECT * FROM games WHERE status = 'draft' AND date <= ? AND date >= ? ORDER BY date DESC",
    c.now.date,
    addDays(c.now.date, -60),
  );
  const games = [];
  for (const g of rows) if ((await pendingIds(c.db, g)).includes(c.member.id)) games.push(view(g));
  return { games };
}

async function latest(c) {
  const g = await c.db.one(
    "SELECT * FROM games WHERE our_score IS NOT NULL AND their_score IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1",
  );
  if (!g) return { game: null };
  const hits = (await c.db.one("SELECT COALESCE(SUM(h), 0) AS h FROM batting WHERE game_id = ?", g.id)).h;
  const theirHits = await c.db.one("SELECT COALESCE(SUM(h), 0) AS h, COUNT(*) AS n FROM pitching WHERE game_id = ?", g.id);
  const mvp = g.mvp_member_id ? publicMember(await c.db.one("SELECT * FROM members WHERE id = ?", g.mvp_member_id)) : null;
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
  game_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  seq BIGINT NOT NULL,
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
