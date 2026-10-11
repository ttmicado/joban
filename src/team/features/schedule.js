// 日程（予定・出欠）・球場マスタ・日程調整・カレンダー購読（ics）
import { raw } from "../app.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { addDays } from "../time.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";

const TYPES = ["game", "practice", "other", "event"];
const TYPE_LABEL = { game: "試合", practice: "練習", other: "その他", event: "イベント" };
// 一般メンバーが登録できる種類（合宿・飲み会などのイベント）。試合・練習は管理者だけ
const MEMBER_TYPES = ["event", "other"];
const MAX_DAYS = 31; // 複数日の予定の最大日数
const MAX_FEE = 1000000; // 参加費の上限（円）
const RSVP = ["yes", "maybe", "no"];

// ---------------------------------------------------------------- 予定

async function getEvent(db, id) {
  const e = await db.one("SELECT * FROM events WHERE id = ?", Number(id));
  if (!e) throw notFound("予定が見つかりません");
  return e;
}

// タイトルの自動提案（フロントと同じルール）
export function suggestTitle(type, opponent) {
  if (type === "game") return opponent ? `vs ${opponent}` : "試合";
  if (type === "practice") return "練習";
  if (type === "event") return "イベント";
  return "予定";
}

// 予定の入力値（partial: PATCH 用に指定された項目だけ）
function eventFields(body, { partial = false } = {}) {
  const has = (k) => !partial || body[k] !== undefined;
  const f = {};
  if (has("type")) f.type = v.oneOf(body.type || (partial ? undefined : "game"), "種類", TYPES, { required: true });
  if (has("title")) f.title = v.str(body.title, "タイトル", { max: 60 });
  if (has("date")) f.date = v.date(body.date, "日付", { required: true });
  if (has("end_date")) f.end_date = v.date(body.end_date, "最終日");
  if (has("meet_time")) f.meet_time = v.time(body.meet_time, "集合時間");
  if (has("start_time")) f.start_time = v.time(body.start_time, "開始時間");
  if (has("end_time")) f.end_time = v.time(body.end_time, "終了時間");
  if (has("meet_place")) f.meet_place = v.str(body.meet_place, "集合場所", { max: 100 });
  if (has("venue")) f.venue = v.str(body.venue, "球場", { max: 100 });
  if (has("venue_url")) f.venue_url = v.url(body.venue_url, "地図URL");
  if (has("opponent")) f.opponent = v.str(body.opponent, "対戦相手", { max: 60 });
  if (has("belongings")) f.belongings = v.str(body.belongings, "持ち物", { max: 500 });
  if (has("note")) f.note = v.str(body.note, "メモ", { max: 2000 });
  if (has("rsvp_deadline")) f.rsvp_deadline = v.date(body.rsvp_deadline, "出欠締切");
  if (has("fee")) f.fee = v.int(body.fee, "参加費", { min: 0, max: MAX_FEE });
  if (has("fee_note")) f.fee_note = v.str(body.fee_note, "参加費のメモ", { max: 100 });
  return f;
}

// 日数（"2026-11-14"〜"2026-11-15" → 2）
const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

function checkEvent(e) {
  if (e.end_date) {
    if (e.end_date < e.date) throw badRequest("最終日は開始日以降の日付にしてください");
    if (e.end_date === e.date) e.end_date = null; // 1日だけなら最終日なし
    else if (dayCount(e.date, e.end_date) > MAX_DAYS) throw badRequest(`期間は${MAX_DAYS}日以内にしてください`);
  }
  // 複数日の予定は終了時間が最終日の時刻なので、開始時間より前でもよい
  if (!e.end_date && e.start_time && e.end_time && e.end_time < e.start_time) throw badRequest("終了時間は開始時間より後にしてください");
  if (e.meet_time && e.start_time && e.start_time < e.meet_time) throw badRequest("開始時間は集合時間より後にしてください");
  if (e.rsvp_deadline && e.rsvp_deadline > e.date) throw badRequest("出欠締切は予定日までの日付にしてください");
  if (!e.title) e.title = suggestTitle(e.type, e.opponent);
}

// 編集・中止・削除できるか: 管理者は全部、一般メンバーは自分が登録したイベント（その他）だけ
export function canEditEvent(c, e) {
  if (c.isAdmin) return true;
  return !!c.member && e.created_by !== null && e.created_by !== undefined && Number(e.created_by) === Number(c.member.id) && MEMBER_TYPES.includes(e.type);
}

function requireCanEdit(c, e) {
  if (!canEditEvent(c, e)) throw forbidden("この予定を変更できるのは管理者か登録した人だけです");
}

// 一般メンバーが登録・変更できる種類か
function requireTypeAllowed(c, type) {
  if (!c.isAdmin && !MEMBER_TYPES.includes(type)) throw forbidden("試合・練習の登録は管理者だけができます。イベントとして登録してください");
}

async function insertEvent(c, f) {
  const e = { type: "game", title: null, ...f };
  checkEvent(e);
  const { lastId } = await c.db.run(
    `INSERT INTO events(type, title, date, end_date, meet_time, start_time, end_time, venue, venue_url, meet_place, opponent,
       belongings, note, rsvp_deadline, fee, fee_note, created_by, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.type,
    e.title,
    e.date,
    e.end_date ?? null,
    e.meet_time ?? null,
    e.start_time ?? null,
    e.end_time ?? null,
    e.venue ?? null,
    e.venue_url ?? null,
    e.meet_place ?? null,
    e.opponent ?? null,
    e.belongings ?? null,
    e.note ?? null,
    e.rsvp_deadline ?? null,
    e.fee ?? null,
    e.fee_note ?? null,
    c.member?.id ?? null,
    c.now.ts,
    c.now.ts,
  );
  return await getEvent(c.db, lastId);
}

// 予定ごとの出欠数（アクティブなメンバーだけ数える）
async function countsFor(db, ids) {
  const out = new Map(ids.map((id) => [id, { yes: 0, maybe: 0, no: 0 }]));
  if (!ids.length) return out;
  const rows = await db.all(
    `SELECT a.event_id, a.status, COUNT(*) AS n FROM attendance a JOIN members m ON m.id = a.member_id
     WHERE m.active = 1 AND a.event_id IN (${ids.map(() => "?").join(",")}) GROUP BY a.event_id, a.status`,
    ...ids,
  );
  for (const r of rows) out.get(r.event_id)[r.status] = r.n;
  return out;
}

async function listEvents(c, where, params, order, limit = 200) {
  const rows = await c.db.all(`SELECT * FROM events WHERE ${where} ORDER BY ${order} LIMIT ${limit}`, ...params);
  const ids = rows.map((r) => r.id);
  const counts = await countsFor(c.db, ids);
  const mine = new Map();
  const games = new Map();
  const guides = await guideIds(c.db, ids);
  if (ids.length) {
    const qs = ids.map(() => "?").join(",");
    for (const a of await c.db.all(`SELECT event_id, status FROM attendance WHERE member_id = ? AND event_id IN (${qs})`, c.member.id, ...ids)) {
      mine.set(a.event_id, a.status);
    }
    for (const g of await c.db.all(`SELECT id, event_id FROM games WHERE event_id IN (${qs}) ORDER BY id`, ...ids)) {
      if (!games.has(g.event_id)) games.set(g.event_id, g.id);
    }
  }
  return rows.map((r) => ({
    ...r,
    counts: counts.get(r.id),
    my_status: mine.get(r.id) || null,
    game_id: games.get(r.id) || null,
    days: r.end_date ? dayCount(r.date, r.end_date) : 1,
    can_edit: canEditEvent(c, r),
    hasGuide: guides.has(r.id),
  }));
}

const activeRoster = async (db) =>
  await db.all(
    `SELECT * FROM members WHERE active = 1
     ORDER BY is_guest, CASE WHEN number ~ '^[0-9]+$' THEN CAST(number AS BIGINT) ELSE 9999 END, id`,
  );

// 予定の詳細（出欠一覧・自分の出欠・関連する試合）
async function eventDetail(c, id) {
  const event = await getEvent(c.db, id);
  const roster = await activeRoster(c.db);
  const att = new Map((await c.db.all("SELECT * FROM attendance WHERE event_id = ?", event.id)).map((a) => [a.member_id, a]));
  const attendance = [];
  const unanswered = [];
  for (const m of roster) {
    const a = att.get(m.id);
    if (a) attendance.push({ member: publicMember(m), status: a.status, comment: a.comment || "", updated_at: a.updated_at });
    else if (!m.is_guest) unanswered.push(publicMember(m));
  }
  attendance.sort((a, b) => a.updated_at - b.updated_at);
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const a of attendance) counts[a.status]++;
  const mine = att.get(c.member.id);
  const game = await c.db.one("SELECT id FROM games WHERE event_id = ? ORDER BY id LIMIT 1", event.id);
  const venue = event.venue ? await c.db.one("SELECT * FROM venues WHERE name = ?", event.venue) : null;
  const creator = event.created_by ? await c.db.one("SELECT * FROM members WHERE id = ?", event.created_by) : null;
  const hasGuide = !!(await c.db.one("SELECT event_id FROM event_guides WHERE event_id = ?", event.id));
  return {
    event: { ...event, counts, days: event.end_date ? dayCount(event.date, event.end_date) : 1, hasGuide },
    hasGuide,
    attendance,
    unanswered,
    my: mine ? { status: mine.status, comment: mine.comment || "" } : null,
    game_id: game?.id || null,
    venue,
    creator: creator ? publicMember(creator) : null,
    can_edit: canEditEvent(c, event),
    today: c.now.date,
  };
}

async function setRsvp(c) {
  const event = await getEvent(c.db, c.params.id);
  const memberId = c.body.member_id !== undefined && c.body.member_id !== null && c.body.member_id !== "" ? v.int(c.body.member_id, "メンバー", { min: 1 }) : c.member.id;
  c.requireAdminOrSelf(memberId);
  const target = await c.db.one("SELECT * FROM members WHERE id = ? AND active = 1", memberId);
  if (!target) throw notFound("メンバーが見つかりません");
  if (event.status === "canceled") throw badRequest("この予定は中止になりました");
  if (!c.isAdmin && (event.end_date || event.date) < c.now.date) throw badRequest("終わった予定の出欠は変更できません");
  const comment = v.str(c.body.comment, "コメント", { max: 100 });
  if (c.body.status === null || c.body.status === "" || c.body.status === "none") {
    await c.db.run("DELETE FROM attendance WHERE event_id = ? AND member_id = ?", event.id, memberId);
  } else {
    const status = v.oneOf(c.body.status, "出欠", RSVP, { required: true });
    await c.db.run(
      `INSERT INTO attendance(event_id, member_id, status, comment, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET status = excluded.status, comment = excluded.comment, updated_at = excluded.updated_at`,
      event.id,
      memberId,
      status,
      comment,
      c.now.ts,
    );
  }
  return await eventDetail(c, event.id);
}

async function updateEvent(c) {
  const before = await getEvent(c.db, c.params.id);
  requireCanEdit(c, before);
  const f = eventFields(c.body, { partial: true });
  const next = { ...before, ...f };
  requireTypeAllowed(c, next.type);
  checkEvent(next); // タイトルが空なら種類・相手から自動提案
  f.title = next.title;
  if (f.end_date !== undefined || f.date !== undefined) f.end_date = next.end_date ?? null;
  const keys = Object.keys(f);
  await c.db.run(
    `UPDATE events SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => f[k]),
    c.now.ts,
    before.id,
  );
  const event = await getEvent(c.db, before.id);
  c.emit("event.updated", { event, before });
  return { event };
}

// 自分の未回答（これからの予定 + 受付中の日程調整）
async function pending(c) {
  const events = await c.db.all(
    `SELECT e.* FROM events e WHERE COALESCE(e.end_date, e.date) >= ? AND e.status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = e.id AND a.member_id = ?)
     ORDER BY e.date, COALESCE(e.meet_time, e.start_time, '99:99'), e.id`,
    c.now.date,
    c.member.id,
  );
  const polls = await c.db.all(
    `SELECT p.* FROM polls p WHERE p.status = 'open' AND (p.deadline IS NULL OR p.deadline >= ?)
       AND NOT EXISTS (SELECT 1 FROM poll_answers x WHERE x.poll_id = p.id AND x.member_id = ?)
     ORDER BY p.deadline IS NULL, p.deadline, p.id`,
    c.now.date,
    c.member.id,
  );
  return { events, polls, count: events.length + polls.length };
}

// ---------------------------------------------------------------- 球場

function venueFields(body) {
  return {
    name: v.str(body.name, "球場名", { max: 100, required: true }),
    address: v.str(body.address, "住所", { max: 200 }),
    url: v.url(body.url, "地図URL"),
    note: v.str(body.note, "メモ", { max: 1000 }),
  };
}

async function getVenue(db, id) {
  const r = await db.one("SELECT * FROM venues WHERE id = ?", Number(id));
  if (!r) throw notFound("球場が見つかりません");
  return r;
}

// ---------------------------------------------------------------- 日程調整

async function getPoll(db, id) {
  const p = await db.one("SELECT * FROM polls WHERE id = ?", Number(id));
  if (!p) throw notFound("日程調整が見つかりません");
  return p;
}

const pollOptions = async (db, pollId) => await db.all("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY sort, date, time NULLS FIRST, id", pollId);

function optionFields(list) {
  if (!Array.isArray(list) || !list.length) throw badRequest("候補日を1つ以上入れてください");
  if (list.length > 20) throw badRequest("候補日は20件までにしてください");
  const out = list.map((o, i) => ({
    date: v.date(o?.date, `候補${i + 1}の日付`, { required: true }),
    time: v.time(o?.time, `候補${i + 1}の時間`),
    note: v.str(o?.note, `候補${i + 1}のメモ`, { max: 100 }),
  }));
  const keys = new Set(out.map((o) => `${o.date} ${o.time || ""}`));
  if (keys.size !== out.length) throw badRequest("同じ候補が重複しています");
  return out;
}

async function pollDetail(c, id) {
  const poll = await getPoll(c.db, id);
  const options = (await pollOptions(c.db, poll.id)).map((o) => ({ ...o, counts: { yes: 0, maybe: 0, no: 0 } }));
  const byId = new Map(options.map((o) => [o.id, o]));
  const roster = await activeRoster(c.db);
  const ans = new Map((await c.db.all("SELECT * FROM poll_answers WHERE poll_id = ?", poll.id)).map((a) => [a.member_id, a]));
  const answers = [];
  const unanswered = [];
  for (const m of roster) {
    const a = ans.get(m.id);
    if (!a) {
      if (!m.is_guest) unanswered.push(publicMember(m));
      continue;
    }
    const map = JSON.parse(a.answers || "{}");
    for (const [oid, val] of Object.entries(map)) {
      const o = byId.get(Number(oid));
      if (o && RSVP.includes(val)) o.counts[val] += 1;
    }
    answers.push({ member: publicMember(m), answers: map, comment: a.comment || "", updated_at: a.updated_at });
  }
  // 最有力: ○ の数 → △ の数 の順
  let best = [];
  let top = null;
  for (const o of options) {
    const score = [o.counts.yes, o.counts.maybe];
    if (!top || score[0] > top[0] || (score[0] === top[0] && score[1] > top[1])) {
      top = score;
      best = [o.id];
    } else if (score[0] === top[0] && score[1] === top[1]) best.push(o.id);
  }
  if (!top || top[0] + top[1] === 0) best = [];
  const mine = ans.get(c.member.id);
  return {
    poll,
    options,
    answers,
    unanswered,
    best,
    my: mine ? { answers: JSON.parse(mine.answers || "{}"), comment: mine.comment || "" } : null,
    today: c.now.date,
  };
}

// ---------------------------------------------------------------- iCalendar

const icsEscape = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

// 75 オクテットごとに折り返す（UTF-8 の文字の途中では切らない）
export function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
      limit = 74; // 続きの行は先頭の空白1文字ぶん短く
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const icsDate = (d) => d.replace(/-/g, "");
const icsLocal = (d, t) => `${icsDate(d)}T${t.replace(":", "")}00`;
const icsUtc = (ts) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const fmtMd = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${m}/${day}(${"日月火水木金土"[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]})`;
};
const nightsLabel = (from, to) => {
  const n = dayCount(from, to);
  return n > 1 ? `${n - 1}泊${n}日` : "日帰り";
};
const feeLabel = (fee) => (Number(fee) === 0 ? "無料" : `${Number(fee).toLocaleString("ja-JP")}円`);
const plusMinutes = (date, time, mins) => {
  const [h, m] = time.split(":").map(Number);
  let total = h * 60 + m + mins;
  let d = date;
  while (total >= 24 * 60) {
    total -= 24 * 60;
    d = addDays(d, 1);
  }
  return [d, `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`];
};

function appLink(env, path, origin) {
  if (env.LIFF_ID) return `https://liff.line.me/${env.LIFF_ID}/#${path}`;
  const base = env.APP_URL || origin;
  if (base) return `${String(base).replace(/\/$/, "")}/#${path}`;
  return null;
}

// お笑いライブ（lives 機能）を ics に含める。lives は別機能なのでテーブルを直接読む（列は lives.js の定義に合わせる）
function liveVevent(c, l) {
  const lines = [];
  const start = l.open_time || l.start_time;
  const desc = [];
  if (l.performer) desc.push(`出演: ${l.performer}`);
  if (l.open_time || l.start_time) desc.push([l.open_time && `開場 ${l.open_time}`, l.start_time && `開演 ${l.start_time}`].filter(Boolean).join(" / "));
  const price = [l.price_advance != null && `前売 ${feeLabel(l.price_advance)}`, l.price_door != null && `当日 ${feeLabel(l.price_door)}`].filter(Boolean).join(" / ");
  if (price || l.price_note) desc.push(`料金: ${[price, l.price_note].filter(Boolean).join(" ")}`);
  if (l.note) desc.push(`メモ: ${l.note}`);
  const link = appLink(c.env, `/lives/${l.id}`, c.headers?.origin);
  if (link) desc.push(`詳細: ${link}`);
  lines.push("BEGIN:VEVENT", `UID:live-${l.id}@joban-team`, `DTSTAMP:${icsUtc(l.updated_at)}`, `LAST-MODIFIED:${icsUtc(l.updated_at)}`);
  if (start) {
    let end;
    if (l.end_time && l.end_time > start) end = [l.date, l.end_time];
    else end = plusMinutes(l.date, l.start_time || start, l.start_time && l.start_time !== start ? 120 : 150);
    lines.push(`DTSTART;TZID=Asia/Tokyo:${icsLocal(l.date, start)}`, `DTEND;TZID=Asia/Tokyo:${icsLocal(end[0], end[1])}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(l.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(l.date, 1))}`);
  }
  lines.push(`SUMMARY:${icsEscape(`${l.status === "canceled" ? "【中止】" : ""}🎤 ${l.title}`)}`);
  if (l.venue) lines.push(`LOCATION:${icsEscape(l.venue)}`);
  if (desc.length) lines.push(`DESCRIPTION:${icsEscape(desc.join("\n"))}`);
  if (link) lines.push(`URL:${link}`);
  lines.push("CATEGORIES:ライブ", `STATUS:${l.status === "canceled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  return lines;
}

export function buildIcs(c, events, lives = []) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//joban//team-schedule//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(c.settings.teamName || "チーム")}`,
    "X-WR-TIMEZONE:Asia/Tokyo",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tokyo",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:JST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const e of events) {
    const start = e.meet_time || e.start_time;
    const multi = !!e.end_date && e.end_date > e.date;
    const desc = [];
    if (multi) desc.push(`期間: ${fmtMd(e.date)}〜${fmtMd(e.end_date)}（${nightsLabel(e.date, e.end_date)}）`);
    if (e.meet_time) desc.push(`集合: ${e.meet_time}${e.meet_place ? `（${e.meet_place}）` : ""}`);
    else if (e.meet_place) desc.push(`集合場所: ${e.meet_place}`);
    if (e.start_time) desc.push(`開始: ${e.start_time}${e.end_time ? `〜${e.end_time}` : ""}`);
    if (e.opponent) desc.push(`対戦相手: ${e.opponent}`);
    if (e.fee !== null && e.fee !== undefined) desc.push(`参加費: ${feeLabel(e.fee)}${e.fee_note ? `（${e.fee_note}）` : ""}`);
    else if (e.fee_note) desc.push(`参加費: ${e.fee_note}`);
    if (e.belongings) desc.push(`持ち物: ${e.belongings}`);
    if (e.note) desc.push(`メモ: ${e.note}`);
    const link = appLink(c.env, `/schedule/${e.id}`, c.headers?.origin);
    if (link) desc.push(`出欠・詳細: ${link}`);
    const summary = `${e.status === "canceled" ? "【中止】" : ""}${e.title}`;
    lines.push("BEGIN:VEVENT", `UID:event-${e.id}@joban-team`, `DTSTAMP:${icsUtc(e.updated_at)}`, `LAST-MODIFIED:${icsUtc(e.updated_at)}`);
    if (multi) {
      // 合宿など複数日: 終日の予定（DTEND は最終日の翌日）。時間は説明に入れる
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.end_date, 1))}`);
    } else if (start) {
      let end;
      if (e.end_time && e.end_time > start) end = [e.date, e.end_time];
      else end = plusMinutes(e.date, e.start_time || start, e.start_time && e.start_time !== start ? 120 : 180);
      lines.push(`DTSTART;TZID=Asia/Tokyo:${icsLocal(e.date, start)}`, `DTEND;TZID=Asia/Tokyo:${icsLocal(end[0], end[1])}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.date, 1))}`);
    }
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    if (e.venue) lines.push(`LOCATION:${icsEscape(e.venue)}`);
    if (desc.length) lines.push(`DESCRIPTION:${icsEscape(desc.join("\n"))}`);
    if (link) lines.push(`URL:${link}`);
    lines.push(`CATEGORIES:${icsEscape(TYPE_LABEL[e.type] || "予定")}`);
    lines.push(`STATUS:${e.status === "canceled" ? "CANCELLED" : "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }
  for (const l of lives) lines.push(...liveVevent(c, l));
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- しおり（予定ごとのガイドブック）
// event_guides.data は JSON: { title, subtitle, message, sections: [{ id, type, title, icon, note, ...中身 }] }

export const GUIDE_TYPES = ["timeline", "stay", "checklist", "rooms", "text", "links"];
export const GUIDE_LIMITS = {
  sections: 20,
  days: 10,
  dayItems: 40,
  checklist: 80,
  rooms: 30,
  roomMembers: 20,
  links: 20,
  json: 40000,
};
const GUIDE_DEFAULT_TITLE = { timeline: "旅程", stay: "宿泊先", checklist: "持ち物", rooms: "部屋割り", text: "メモ", links: "リンク" };
const GUIDE_DEFAULT_ICON = { timeline: "🗓", stay: "🏠", checklist: "🎒", rooms: "🛏", text: "📝", links: "🔗" };

const gStr = (val, label, max, opts) => v.str(val, label, { max, ...opts }) ?? "";
// 改行を保つ文字列（本文など）。前後の空白だけ落とす
function gText(val, label, max) {
  if (val === undefined || val === null) return "";
  if (typeof val !== "string") throw badRequest(`${label}の形式が不正です`);
  const s = val.replace(/\r\n?/g, "\n").trim();
  if (s.length > max) throw badRequest(`${label}は${max}文字以内にしてください`);
  return s;
}
const gUrl = (val, label) => v.url(val, label) ?? "";
function gArr(val, label, max) {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val)) throw badRequest(`${label}の形式が不正です`);
  if (val.length > max) throw badRequest(`${label}は${max}件までにしてください`);
  return val;
}
const gObj = (val) => (val && typeof val === "object" && !Array.isArray(val) ? val : {});

// しおりの検証（未知のキーは捨てる。不正な値は 400）
export function sanitizeGuide(input) {
  const g = gObj(input);
  if (JSON.stringify(g).length > GUIDE_LIMITS.json) throw badRequest("しおりの内容が長すぎます");
  const out = {
    title: gStr(g.title, "しおりのタイトル", 60),
    subtitle: gStr(g.subtitle, "サブタイトル", 80),
    message: gText(g.message, "ひとこと", 300),
    sections: [],
  };
  const ids = new Set();
  for (const [i, raw0] of gArr(g.sections, "セクション", GUIDE_LIMITS.sections).entries()) {
    const s = gObj(raw0);
    const n = `セクション${i + 1}`;
    const type = v.oneOf(s.type, `${n}の種類`, GUIDE_TYPES, { required: true });
    let id = typeof s.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(s.id) ? s.id : `s${i + 1}`;
    while (ids.has(id)) id = `${id.slice(0, 20)}_${i + 1}`;
    ids.add(id);
    const sec = {
      id,
      type,
      title: gStr(s.title, `${n}の見出し`, 40) || GUIDE_DEFAULT_TITLE[type],
      icon: gStr(s.icon, `${n}のアイコン`, 16) || GUIDE_DEFAULT_ICON[type],
      note: gText(s.note, `${n}の補足`, 1000),
    };
    if (type === "timeline") {
      sec.days = gArr(s.days, `${n}の日`, GUIDE_LIMITS.days).map((d0, di) => {
        const d = gObj(d0);
        return {
          label: gStr(d.label, `${n}の日の見出し`, 40) || `${di + 1}日目`,
          items: gArr(d.items, `${n}の予定`, GUIDE_LIMITS.dayItems)
            .map((it0) => {
              const it = gObj(it0);
              return { time: gStr(it.time, `${n}の時刻`, 20), text: gStr(it.text, `${n}の予定`, 200) };
            })
            .filter((it) => it.time || it.text),
        };
      });
    } else if (type === "stay") {
      sec.name = gStr(s.name, `${n}の宿名`, 100);
      sec.address = gStr(s.address, `${n}の住所`, 200);
      sec.url = gUrl(s.url, `${n}の予約ページ`);
      sec.mapUrl = gUrl(s.mapUrl, `${n}の地図URL`);
      sec.checkin = gStr(s.checkin, `${n}のチェックイン`, 40);
      sec.checkout = gStr(s.checkout, `${n}のチェックアウト`, 40);
    } else if (type === "checklist") {
      sec.items = gArr(s.items, `${n}の項目`, GUIDE_LIMITS.checklist)
        .map((x) => gStr(x, `${n}の項目`, 100))
        .filter(Boolean);
    } else if (type === "rooms") {
      sec.rooms = gArr(s.rooms, `${n}の部屋`, GUIDE_LIMITS.rooms).map((r0) => {
        const r = gObj(r0);
        return {
          name: gStr(r.name, `${n}の部屋名`, 40),
          members: gArr(r.members, `${n}のメンバー`, GUIDE_LIMITS.roomMembers)
            .map((x) => gStr(x, `${n}のメンバー名`, 30))
            .filter(Boolean),
        };
      }).filter((r) => r.name || r.members.length);
    } else if (type === "text") {
      sec.body = gText(s.body, `${n}の本文`, 3000);
    } else if (type === "links") {
      sec.links = gArr(s.links, `${n}のリンク`, GUIDE_LIMITS.links)
        .map((l0) => {
          const l = gObj(l0);
          const url = gUrl(l.url, `${n}のリンクURL`);
          return { label: gStr(l.label, `${n}のリンク名`, 60) || url, url };
        })
        .filter((l) => l.url);
    }
    out.sections.push(sec);
  }
  if (!out.title && !out.sections.length) throw badRequest("しおりのタイトルかセクションを入れてください");
  return out;
}

async function guideIds(db, ids) {
  if (!ids.length) return new Set();
  const rows = await db.all(`SELECT event_id FROM event_guides WHERE event_id IN (${ids.map(() => "?").join(",")})`, ...ids);
  return new Set(rows.map((r) => r.event_id));
}

async function readGuide(c, eventId) {
  const row = await c.db.one("SELECT * FROM event_guides WHERE event_id = ?", eventId);
  if (!row) return { guide: null, can_edit: !!c.isAdmin };
  let guide = null;
  try {
    guide = sanitizeGuide(JSON.parse(row.data));
  } catch {
    guide = { title: "しおり", subtitle: "", message: "", sections: [] };
  }
  return { guide, updated_at: row.updated_at, can_edit: !!c.isAdmin };
}

// 初期データ: 白馬合宿（2027-02-13〜14）とそのしおり
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const HAKUBA_NAME = "コテージ 白馬 ムジェーヴ";
const HAKUBA_MAP = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(HAKUBA_NAME)}`;
const HAKUBA_BOOKING = "https://www.agoda.com/sh-app/HmTdb46w6Jw";
export const HAKUBA_GUIDE = {
  title: "白馬合宿のしおり",
  subtitle: "2027.2.13 SAT – 2.14 SUN",
  message: "最高の2日間にしよう！",
  sections: [
    {
      id: "schedule",
      type: "timeline",
      title: "旅程",
      icon: "🗓",
      days: [
        { label: "2/13(土) 1日目", items: [{ time: "", text: "未定（管理者が追加します）" }] },
        { label: "2/14(日) 2日目", items: [{ time: "", text: "未定（管理者が追加します）" }] },
      ],
    },
    {
      id: "stay",
      type: "stay",
      title: "宿泊先",
      icon: "🏠",
      name: HAKUBA_NAME,
      url: HAKUBA_BOOKING,
      mapUrl: HAKUBA_MAP,
      checkin: "",
      checkout: "",
    },
    {
      id: "items",
      type: "checklist",
      title: "持ち物",
      icon: "🎒",
      items: [
        "グローブ",
        "スパイク／トレーニングシューズ",
        "ユニフォーム・練習着",
        "防寒着（ダウン・手袋・ニット帽）",
        "雪道用の靴・長靴",
        "着替え（2日分）",
        "パジャマ・部屋着",
        "洗面用具・タオル",
        "保険証",
        "常備薬",
        "スマホの充電器",
        "カイロ",
      ],
      note: "白馬の2月は氷点下になります。あたたかい服装で！",
    },
    { id: "rooms", type: "rooms", title: "部屋割り", icon: "🛏", rooms: [], note: "決まり次第お知らせします" },
    { id: "cost", type: "text", title: "費用", icon: "💴", body: "決まり次第お知らせします" },
    {
      id: "notes",
      type: "text",
      title: "注意事項",
      icon: "⚠️",
      body: [
        "・集合時間は厳守！遅れそうなときは早めに連絡してください",
        "・雪道の運転に注意。車はスタッドレスタイヤかチェーンを必ず用意",
        "・路面凍結に注意。歩くときも滑りにくい靴で",
        "・体調が悪いときは無理をしない",
        "・コテージは貸切です。ゴミの分別・夜の騒音に気をつけましょう",
        "・忘れ物がないよう、チェックアウト前に部屋を確認",
      ].join("\n"),
    },
    { id: "contact", type: "text", title: "連絡先", icon: "📞", body: "" },
  ],
};

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- モジュール

export default {
  name: "schedule",
  migrations: [
    {
      id: "schedule-001",
      sql: `
CREATE TABLE IF NOT EXISTS venues (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  url TEXT,                              -- 地図URL
  note TEXT,                             -- 駐車場・注意事項など
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS venues_name ON venues(name);

-- 日程調整
CREATE TABLE IF NOT EXISTS polls (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  deadline TEXT,                         -- 回答締切日
  status TEXT NOT NULL DEFAULT 'open',   -- open / decided / closed
  decided_option_id BIGINT,
  event_id BIGINT,                      -- 決定して作った予定
  created_by BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id BIGSERIAL PRIMARY KEY,
  poll_id BIGINT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,                             -- 開始時間（任意）
  note TEXT,                             -- 球場などのメモ
  sort BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS poll_options_poll ON poll_options(poll_id);
-- 回答（1人1行。answers は {候補id: "yes"|"maybe"|"no"} の JSON）
CREATE TABLE IF NOT EXISTS poll_answers (
  poll_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  answers TEXT NOT NULL,
  comment TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (poll_id, member_id)
);
`,
    },
    {
      // 合宿・飲み会などのイベント（type = 'event'）向けの項目
      id: "schedule-002",
      sql: `
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date TEXT;   -- 最終日（合宿など複数日。NULL なら1日）
ALTER TABLE events ADD COLUMN IF NOT EXISTS fee BIGINT;      -- 参加費（円）
ALTER TABLE events ADD COLUMN IF NOT EXISTS fee_note TEXT;   -- 参加費のメモ（宿泊・食事込み など）
`,
    },
    {
      // しおり（予定ごとのガイドブック。data は JSON。管理者が編集）
      id: "schedule-003",
      sql: `
CREATE TABLE IF NOT EXISTS event_guides (
  event_id BIGINT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_by BIGINT,
  updated_at BIGINT NOT NULL
);
`,
    },
    {
      // 初期データ: 白馬合宿 2027-02-13(土)〜14(日) とそのしおり（同じ日付・タイトルの予定があれば入れない）
      id: "schedule-004",
      sql: `
INSERT INTO events(type, title, date, end_date, venue, venue_url, note, status, created_by, created_at, updated_at)
SELECT 'event', '白馬合宿', '2027-02-13', '2027-02-14', ${sqlStr(HAKUBA_NAME)}, ${sqlStr(HAKUBA_MAP)},
  '1泊2日の合宿です。詳しくはしおりを見てください', 'scheduled', NULL, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.date = '2027-02-13' AND e.title = '白馬合宿');
INSERT INTO event_guides(event_id, data, updated_by, updated_at)
SELECT e.id, ${sqlStr(JSON.stringify(HAKUBA_GUIDE))}, NULL, 0
FROM events e WHERE e.date = '2027-02-13' AND e.title = '白馬合宿'
ORDER BY e.id LIMIT 1
ON CONFLICT (event_id) DO NOTHING;
`,
    },
  ],
  routes: [
    // ---------------- 予定
    [
      "GET",
      "/events",
      async (c) => {
        const range = v.oneOf(c.query.range, "表示範囲", ["upcoming", "past", "month"]) || "upcoming";
        if (range === "month") {
          const month = c.query.month || c.now.date.slice(0, 7);
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("月の形式が不正です");
          // 月をまたぐ合宿なども、期間がその月にかかっていれば出す
          return {
            events: await listEvents(c, "date <= ? AND COALESCE(end_date, date) >= ?", [`${month}-31`, `${month}-01`], "date, COALESCE(meet_time, start_time, '99:99'), id"),
            month,
            today: c.now.date,
          };
        }
        if (range === "past") {
          const limit = v.int(c.query.limit, "件数", { min: 1, max: 500 }) || 100;
          return { events: await listEvents(c, "COALESCE(end_date, date) < ?", [c.now.date], "date DESC, COALESCE(meet_time, start_time, '99:99') DESC, id DESC", limit), today: c.now.date };
        }
        return { events: await listEvents(c, "COALESCE(end_date, date) >= ?", [c.now.date], "date, COALESCE(meet_time, start_time, '99:99'), id"), today: c.now.date };
      },
    ],
    ["GET", "/events/pending", pending],
    [
      "GET",
      "/events/next",
      async (c) => {
        const e = await c.db.one(
          `SELECT id FROM events WHERE COALESCE(end_date, date) >= ? AND status = 'scheduled'
           ORDER BY date, COALESCE(meet_time, start_time, '99:99'), id LIMIT 1`,
          c.now.date,
        );
        return e ? await eventDetail(c, e.id) : { event: null, today: c.now.date };
      },
    ],
    // 「前回の予定をコピー」用: 種類ごとに最後に作った予定（中止は後回し）
    [
      "GET",
      "/events/latest",
      async (c) => {
        const type = v.oneOf(c.query.type, "種類", TYPES);
        const e = type
          ? await c.db.one("SELECT * FROM events WHERE type = ? ORDER BY status = 'canceled', created_at DESC, id DESC LIMIT 1", type)
          : await c.db.one("SELECT * FROM events ORDER BY status = 'canceled', created_at DESC, id DESC LIMIT 1");
        return { event: e || null };
      },
      { auth: "admin" },
    ],
    ["GET", "/events/:id", (c) => eventDetail(c, c.params.id)],
    [
      "POST",
      "/events",
      async (c) => {
        const f = eventFields(c.body);
        requireTypeAllowed(c, f.type);
        const event = await insertEvent(c, f);
        c.emit("event.created", { event });
        return { event };
      },
    ],
    ["PATCH", "/events/:id", updateEvent],
    [
      "POST",
      "/events/:id/cancel",
      async (c) => {
        const before = await getEvent(c.db, c.params.id);
        requireCanEdit(c, before);
        if (before.status === "canceled") return { event: before };
        await c.db.run("UPDATE events SET status = 'canceled', updated_at = ? WHERE id = ?", c.now.ts, before.id);
        const event = await getEvent(c.db, before.id);
        c.emit("event.canceled", { event });
        return { event };
      },
    ],
    // 中止の取り消し
    [
      "POST",
      "/events/:id/restore",
      async (c) => {
        const before = await getEvent(c.db, c.params.id);
        requireCanEdit(c, before);
        if (before.status !== "canceled") return { event: before };
        await c.db.run("UPDATE events SET status = 'scheduled', updated_at = ? WHERE id = ?", c.now.ts, before.id);
        const event = await getEvent(c.db, before.id);
        c.emit("event.updated", { event, before });
        return { event };
      },
    ],
    [
      "DELETE",
      "/events/:id",
      async (c) => {
        const e = await getEvent(c.db, c.params.id);
        requireCanEdit(c, e);
        if (await c.db.one("SELECT id FROM games WHERE event_id = ? LIMIT 1", e.id)) {
          throw conflict("試合結果が登録されている予定は削除できません。中止にしてください");
        }
        const hasWakeups = !!(await c.db.one("SELECT to_regclass('wakeups') AS t")).t;
        await c.db.tx(async () => {
          await c.db.run("DELETE FROM attendance WHERE event_id = ?", e.id);
          await c.db.run("DELETE FROM event_guides WHERE event_id = ?", e.id);
          // 起床報告（community 機能）も一緒に消す
          if (hasWakeups) await c.db.run("DELETE FROM wakeups WHERE event_id = ?", e.id);
          await c.db.run("DELETE FROM events WHERE id = ?", e.id);
          await c.db.run("UPDATE polls SET event_id = NULL WHERE event_id = ?", e.id);
        });
        return { ok: true };
      },
    ],
    ["PUT", "/events/:id/rsvp", setRsvp],

    // ---------------- しおり
    ["GET", "/events/:id/guide", async (c) => readGuide(c, (await getEvent(c.db, c.params.id)).id)],
    [
      "PUT",
      "/events/:id/guide",
      async (c) => {
        const e = await getEvent(c.db, c.params.id);
        const body = gObj(c.body);
        const guide = sanitizeGuide(body.guide ?? body.data ?? body);
        await c.db.run(
          `INSERT INTO event_guides(event_id, data, updated_by, updated_at) VALUES(?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          e.id,
          JSON.stringify(guide),
          c.member.id,
          c.now.ts,
        );
        return await readGuide(c, e.id);
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/events/:id/guide",
      async (c) => {
        const e = await getEvent(c.db, c.params.id);
        await c.db.run("DELETE FROM event_guides WHERE event_id = ?", e.id);
        return { ok: true };
      },
      { auth: "admin" },
    ],

    // ---------------- 球場
    ["GET", "/venues", async (c) => ({ venues: await c.db.all("SELECT * FROM venues ORDER BY name") })],
    [
      "POST",
      "/venues",
      async (c) => {
        const f = venueFields(c.body);
        if (await c.db.one("SELECT id FROM venues WHERE name = ?", f.name)) throw conflict("同じ名前の球場がすでにあります");
        const { lastId } = await c.db.run(
          "INSERT INTO venues(name, address, url, note, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
          f.name,
          f.address,
          f.url,
          f.note,
          c.now.ts,
          c.now.ts,
        );
        return { venue: await getVenue(c.db, lastId) };
      },
      { auth: "admin" },
    ],
    [
      "PATCH",
      "/venues/:id",
      async (c) => {
        const cur = await getVenue(c.db, c.params.id);
        const f = venueFields({ ...cur, ...c.body });
        if (await c.db.one("SELECT id FROM venues WHERE name = ? AND id != ?", f.name, cur.id)) throw conflict("同じ名前の球場がすでにあります");
        await c.db.run(
          "UPDATE venues SET name = ?, address = ?, url = ?, note = ?, updated_at = ? WHERE id = ?",
          f.name,
          f.address,
          f.url,
          f.note,
          c.now.ts,
          cur.id,
        );
        return { venue: await getVenue(c.db, cur.id) };
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/venues/:id",
      async (c) => {
        const cur = await getVenue(c.db, c.params.id);
        await c.db.run("DELETE FROM venues WHERE id = ?", cur.id);
        return { ok: true };
      },
      { auth: "admin" },
    ],

    // ---------------- 日程調整
    [
      "GET",
      "/polls",
      async (c) => {
        const rows = await c.db.all(
          `SELECT p.*,
             (SELECT COUNT(*) FROM poll_options o WHERE o.poll_id = p.id) AS option_count,
             (SELECT COUNT(*) FROM poll_answers x JOIN members m ON m.id = x.member_id WHERE x.poll_id = p.id AND m.active = 1) AS answer_count,
             EXISTS (SELECT 1 FROM poll_answers x WHERE x.poll_id = p.id AND x.member_id = ?) AS answered,
             (SELECT MIN(date) FROM poll_options o WHERE o.poll_id = p.id) AS first_date,
             (SELECT MAX(date) FROM poll_options o WHERE o.poll_id = p.id) AS last_date
           FROM polls p ORDER BY p.status = 'open' DESC, p.created_at DESC LIMIT 100`,
          c.member.id,
        );
        const memberCount = (await c.db.one("SELECT COUNT(*) AS n FROM members WHERE active = 1 AND is_guest = 0")).n;
        return { polls: rows.map((p) => ({ ...p, answered: !!p.answered })), member_count: memberCount, today: c.now.date };
      },
    ],
    ["GET", "/polls/:id", (c) => pollDetail(c, c.params.id)],
    [
      "POST",
      "/polls",
      async (c) => {
        const title = v.str(c.body.title, "タイトル", { max: 60, required: true });
        const note = v.str(c.body.note, "メモ", { max: 1000 });
        const deadline = v.date(c.body.deadline, "締切");
        const opts = optionFields(c.body.options);
        const id = await c.db.tx(async () => {
          const { lastId } = await c.db.run(
            "INSERT INTO polls(title, note, deadline, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
            title,
            note,
            deadline,
            c.member.id,
            c.now.ts,
            c.now.ts,
          );
          for (const [i, o] of opts.entries()) {
            await c.db.run("INSERT INTO poll_options(poll_id, date, time, note, sort) VALUES(?, ?, ?, ?, ?)", lastId, o.date, o.time, o.note, i);
          }
          return lastId;
        });
        const poll = await getPoll(c.db, id);
        const options = await pollOptions(c.db, id);
        c.emit("poll.created", { poll, options });
        return { poll, options };
      },
      { auth: "admin" },
    ],
    [
      "PATCH",
      "/polls/:id",
      async (c) => {
        const p = await getPoll(c.db, c.params.id);
        const f = {};
        if (c.body.title !== undefined) f.title = v.str(c.body.title, "タイトル", { max: 60, required: true });
        if (c.body.note !== undefined) f.note = v.str(c.body.note, "メモ", { max: 1000 });
        if (c.body.deadline !== undefined) f.deadline = v.date(c.body.deadline, "締切");
        if (c.body.status !== undefined) {
          f.status = v.oneOf(c.body.status, "状態", ["open", "closed"], { required: true });
          if (p.status === "decided") throw badRequest("決定済みの日程調整は変更できません");
        }
        const keys = Object.keys(f);
        if (keys.length) {
          await c.db.run(`UPDATE polls SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), c.now.ts, p.id);
        }
        return await pollDetail(c, p.id);
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/polls/:id",
      async (c) => {
        const p = await getPoll(c.db, c.params.id);
        await c.db.tx(async () => {
          await c.db.run("DELETE FROM poll_answers WHERE poll_id = ?", p.id);
          await c.db.run("DELETE FROM poll_options WHERE poll_id = ?", p.id);
          await c.db.run("DELETE FROM polls WHERE id = ?", p.id);
        });
        return { ok: true };
      },
      { auth: "admin" },
    ],
    [
      "PUT",
      "/polls/:id/answer",
      async (c) => {
        const p = await getPoll(c.db, c.params.id);
        const memberId = c.body.member_id ? v.int(c.body.member_id, "メンバー", { min: 1 }) : c.member.id;
        c.requireAdminOrSelf(memberId);
        if (!await c.db.one("SELECT id FROM members WHERE id = ? AND active = 1", memberId)) throw notFound("メンバーが見つかりません");
        if (p.status !== "open") throw badRequest("この日程調整は締め切られました");
        if (!c.isAdmin && p.deadline && p.deadline < c.now.date) throw badRequest("回答の締切を過ぎています");
        const options = await pollOptions(c.db, p.id);
        const input = c.body.answers && typeof c.body.answers === "object" ? c.body.answers : {};
        const answers = {};
        for (const o of options) {
          const val = v.oneOf(input[o.id] ?? input[String(o.id)], "回答", RSVP);
          if (val) answers[o.id] = val;
        }
        for (const k of Object.keys(input)) {
          if (!options.some((o) => String(o.id) === String(k))) throw badRequest("候補が見つかりません");
        }
        if (!Object.keys(answers).length) throw badRequest("どれか1つは ○△× を選んでください");
        const comment = v.str(c.body.comment, "コメント", { max: 100 });
        await c.db.run(
          `INSERT INTO poll_answers(poll_id, member_id, answers, comment, updated_at) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(poll_id, member_id) DO UPDATE SET answers = excluded.answers, comment = excluded.comment, updated_at = excluded.updated_at`,
          p.id,
          memberId,
          JSON.stringify(answers),
          comment,
          c.now.ts,
        );
        return await pollDetail(c, p.id);
      },
    ],
    // この日に決定 → 予定を作って締める
    [
      "POST",
      "/polls/:id/decide",
      async (c) => {
        const p = await getPoll(c.db, c.params.id);
        if (p.status === "decided") throw conflict("すでに決定しています");
        const optionId = v.int(c.body.option_id, "候補", { min: 1, required: true });
        const option = await c.db.one("SELECT * FROM poll_options WHERE id = ? AND poll_id = ?", optionId, p.id);
        if (!option) throw notFound("候補が見つかりません");
        const extra = c.body.event && typeof c.body.event === "object" ? c.body.event : {};
        const f = eventFields(
          {
            type: "game",
            title: p.title,
            start_time: option.time,
            venue: option.note,
            note: p.note,
            ...extra,
            date: option.date,
          },
        );
        const event = await c.db.tx(async () => {
          const e = await insertEvent(c, f);
          await c.db.run(
            "UPDATE polls SET status = 'decided', decided_option_id = ?, event_id = ?, updated_at = ? WHERE id = ?",
            option.id,
            e.id,
            c.now.ts,
            p.id,
          );
          return e;
        });
        const poll = await getPoll(c.db, p.id);
        c.emit("poll.decided", { poll, event });
        return { poll, event };
      },
      { auth: "admin" },
    ],

    // ---------------- カレンダー購読
    [
      "GET",
      "/ics/:token",
      async (c) => {
        if (!safeEqual(c.params.token, c.settings.icsToken)) throw notFound("カレンダーが見つかりません");
        const events = await c.db.all("SELECT * FROM events WHERE date >= ? ORDER BY date, id", addDays(c.now.date, -365));
        const from = addDays(c.now.date, -365);
        const hasLives = !!(await c.db.one("SELECT to_regclass('lives') AS t")).t;
        const lives = hasLives ? await c.db.all("SELECT * FROM lives WHERE date >= ? ORDER BY date, id", from) : [];
        return raw(buildIcs(c, events, lives), {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="team.ics"',
            "Cache-Control": "no-cache",
          },
        });
      },
      { auth: "public" },
    ],
  ],
};

export { TYPE_LABEL };
