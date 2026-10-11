// 日程（予定・出欠）・球場マスタ・日程調整・カレンダー購読（ics）
import { raw } from "../app.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { addDays } from "../time.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";

const TYPES = ["game", "practice", "other"];
const TYPE_LABEL = { game: "試合", practice: "練習", other: "その他" };
const RSVP = ["yes", "maybe", "no"];

// ---------------------------------------------------------------- 予定

function getEvent(db, id) {
  const e = db.one("SELECT * FROM events WHERE id = ?", Number(id));
  if (!e) throw notFound("予定が見つかりません");
  return e;
}

// タイトルの自動提案（フロントと同じルール）
export function suggestTitle(type, opponent) {
  if (type === "game") return opponent ? `vs ${opponent}` : "試合";
  if (type === "practice") return "練習";
  return "予定";
}

// 予定の入力値（partial: PATCH 用に指定された項目だけ）
function eventFields(body, { partial = false } = {}) {
  const has = (k) => !partial || body[k] !== undefined;
  const f = {};
  if (has("type")) f.type = v.oneOf(body.type || (partial ? undefined : "game"), "種類", TYPES, { required: true });
  if (has("title")) f.title = v.str(body.title, "タイトル", { max: 60 });
  if (has("date")) f.date = v.date(body.date, "日付", { required: true });
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
  return f;
}

function checkEvent(e) {
  if (e.start_time && e.end_time && e.end_time < e.start_time) throw badRequest("終了時間は開始時間より後にしてください");
  if (e.meet_time && e.start_time && e.start_time < e.meet_time) throw badRequest("開始時間は集合時間より後にしてください");
  if (e.rsvp_deadline && e.rsvp_deadline > e.date) throw badRequest("出欠締切は予定日までの日付にしてください");
  if (!e.title) e.title = suggestTitle(e.type, e.opponent);
}

function insertEvent(c, f) {
  const e = { type: "game", title: null, ...f };
  checkEvent(e);
  const { lastId } = c.db.run(
    `INSERT INTO events(type, title, date, meet_time, start_time, end_time, venue, venue_url, meet_place, opponent,
       belongings, note, rsvp_deadline, created_by, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.type,
    e.title,
    e.date,
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
    c.member?.id ?? null,
    c.now.ts,
    c.now.ts,
  );
  return getEvent(c.db, lastId);
}

// 予定ごとの出欠数（アクティブなメンバーだけ数える）
function countsFor(db, ids) {
  const out = new Map(ids.map((id) => [id, { yes: 0, maybe: 0, no: 0 }]));
  if (!ids.length) return out;
  const rows = db.all(
    `SELECT a.event_id, a.status, COUNT(*) AS n FROM attendance a JOIN members m ON m.id = a.member_id
     WHERE m.active = 1 AND a.event_id IN (${ids.map(() => "?").join(",")}) GROUP BY a.event_id, a.status`,
    ...ids,
  );
  for (const r of rows) out.get(r.event_id)[r.status] = r.n;
  return out;
}

function listEvents(c, where, params, order, limit = 200) {
  const rows = c.db.all(`SELECT * FROM events WHERE ${where} ORDER BY ${order} LIMIT ${limit}`, ...params);
  const ids = rows.map((r) => r.id);
  const counts = countsFor(c.db, ids);
  const mine = new Map();
  const games = new Map();
  if (ids.length) {
    const qs = ids.map(() => "?").join(",");
    for (const a of c.db.all(`SELECT event_id, status FROM attendance WHERE member_id = ? AND event_id IN (${qs})`, c.member.id, ...ids)) {
      mine.set(a.event_id, a.status);
    }
    for (const g of c.db.all(`SELECT id, event_id FROM games WHERE event_id IN (${qs}) ORDER BY id`, ...ids)) {
      if (!games.has(g.event_id)) games.set(g.event_id, g.id);
    }
  }
  return rows.map((r) => ({ ...r, counts: counts.get(r.id), my_status: mine.get(r.id) || null, game_id: games.get(r.id) || null }));
}

const activeRoster = (db) =>
  db.all(
    `SELECT * FROM members WHERE active = 1
     ORDER BY is_guest, CASE WHEN number GLOB '[0-9]*' THEN CAST(number AS INTEGER) ELSE 9999 END, id`,
  );

// 予定の詳細（出欠一覧・自分の出欠・関連する試合）
function eventDetail(c, id) {
  const event = getEvent(c.db, id);
  const roster = activeRoster(c.db);
  const att = new Map(c.db.all("SELECT * FROM attendance WHERE event_id = ?", event.id).map((a) => [a.member_id, a]));
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
  const game = c.db.one("SELECT id FROM games WHERE event_id = ? ORDER BY id LIMIT 1", event.id);
  const venue = event.venue ? c.db.one("SELECT * FROM venues WHERE name = ?", event.venue) : null;
  return {
    event: { ...event, counts },
    attendance,
    unanswered,
    my: mine ? { status: mine.status, comment: mine.comment || "" } : null,
    game_id: game?.id || null,
    venue,
    today: c.now.date,
  };
}

function setRsvp(c) {
  const event = getEvent(c.db, c.params.id);
  const memberId = c.body.member_id !== undefined && c.body.member_id !== null && c.body.member_id !== "" ? v.int(c.body.member_id, "メンバー", { min: 1 }) : c.member.id;
  c.requireAdminOrSelf(memberId);
  const target = c.db.one("SELECT * FROM members WHERE id = ? AND active = 1", memberId);
  if (!target) throw notFound("メンバーが見つかりません");
  if (event.status === "canceled") throw badRequest("この予定は中止になりました");
  if (!c.isAdmin && event.date < c.now.date) throw badRequest("終わった予定の出欠は変更できません");
  const comment = v.str(c.body.comment, "コメント", { max: 100 });
  if (c.body.status === null || c.body.status === "" || c.body.status === "none") {
    c.db.run("DELETE FROM attendance WHERE event_id = ? AND member_id = ?", event.id, memberId);
  } else {
    const status = v.oneOf(c.body.status, "出欠", RSVP, { required: true });
    c.db.run(
      `INSERT INTO attendance(event_id, member_id, status, comment, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET status = excluded.status, comment = excluded.comment, updated_at = excluded.updated_at`,
      event.id,
      memberId,
      status,
      comment,
      c.now.ts,
    );
  }
  return eventDetail(c, event.id);
}

function updateEvent(c) {
  const before = getEvent(c.db, c.params.id);
  const f = eventFields(c.body, { partial: true });
  const next = { ...before, ...f };
  checkEvent(next); // タイトルが空なら種類・相手から自動提案
  f.title = next.title;
  const keys = Object.keys(f);
  c.db.run(
    `UPDATE events SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => f[k]),
    c.now.ts,
    before.id,
  );
  const event = getEvent(c.db, before.id);
  c.emit("event.updated", { event, before });
  return { event };
}

// 自分の未回答（これからの予定 + 受付中の日程調整）
function pending(c) {
  const events = c.db.all(
    `SELECT e.* FROM events e WHERE e.date >= ? AND e.status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = e.id AND a.member_id = ?)
     ORDER BY e.date, COALESCE(e.meet_time, e.start_time, '99:99'), e.id`,
    c.now.date,
    c.member.id,
  );
  const polls = c.db.all(
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

function getVenue(db, id) {
  const r = db.one("SELECT * FROM venues WHERE id = ?", Number(id));
  if (!r) throw notFound("球場が見つかりません");
  return r;
}

// ---------------------------------------------------------------- 日程調整

function getPoll(db, id) {
  const p = db.one("SELECT * FROM polls WHERE id = ?", Number(id));
  if (!p) throw notFound("日程調整が見つかりません");
  return p;
}

const pollOptions = (db, pollId) => db.all("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY sort, date, time, id", pollId);

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

function pollDetail(c, id) {
  const poll = getPoll(c.db, id);
  const options = pollOptions(c.db, poll.id).map((o) => ({ ...o, counts: { yes: 0, maybe: 0, no: 0 } }));
  const byId = new Map(options.map((o) => [o.id, o]));
  const roster = activeRoster(c.db);
  const ans = new Map(c.db.all("SELECT * FROM poll_answers WHERE poll_id = ?", poll.id).map((a) => [a.member_id, a]));
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

export function buildIcs(c, events) {
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
    const desc = [];
    if (e.meet_time) desc.push(`集合: ${e.meet_time}${e.meet_place ? `（${e.meet_place}）` : ""}`);
    else if (e.meet_place) desc.push(`集合場所: ${e.meet_place}`);
    if (e.start_time) desc.push(`開始: ${e.start_time}${e.end_time ? `〜${e.end_time}` : ""}`);
    if (e.opponent) desc.push(`対戦相手: ${e.opponent}`);
    if (e.belongings) desc.push(`持ち物: ${e.belongings}`);
    if (e.note) desc.push(`メモ: ${e.note}`);
    const link = appLink(c.env, `/schedule/${e.id}`, c.headers?.origin);
    if (link) desc.push(`出欠・詳細: ${link}`);
    const summary = `${e.status === "canceled" ? "【中止】" : ""}${e.title}`;
    lines.push("BEGIN:VEVENT", `UID:event-${e.id}@joban-team`, `DTSTAMP:${icsUtc(e.updated_at)}`, `LAST-MODIFIED:${icsUtc(e.updated_at)}`);
    if (start) {
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
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  url TEXT,                              -- 地図URL
  note TEXT,                             -- 駐車場・注意事項など
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS venues_name ON venues(name);

-- 日程調整
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT,
  deadline TEXT,                         -- 回答締切日
  status TEXT NOT NULL DEFAULT 'open',   -- open / decided / closed
  decided_option_id INTEGER,
  event_id INTEGER,                      -- 決定して作った予定
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT,                             -- 開始時間（任意）
  note TEXT,                             -- 球場などのメモ
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS poll_options_poll ON poll_options(poll_id);
-- 回答（1人1行。answers は {候補id: "yes"|"maybe"|"no"} の JSON）
CREATE TABLE IF NOT EXISTS poll_answers (
  poll_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  answers TEXT NOT NULL,
  comment TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, member_id)
);
`,
    },
  ],
  routes: [
    // ---------------- 予定
    [
      "GET",
      "/events",
      (c) => {
        const range = v.oneOf(c.query.range, "表示範囲", ["upcoming", "past", "month"]) || "upcoming";
        if (range === "month") {
          const month = c.query.month || c.now.date.slice(0, 7);
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("月の形式が不正です");
          return { events: listEvents(c, "date LIKE ?", [`${month}-%`], "date, COALESCE(meet_time, start_time, '99:99'), id"), month, today: c.now.date };
        }
        if (range === "past") {
          const limit = v.int(c.query.limit, "件数", { min: 1, max: 500 }) || 100;
          return { events: listEvents(c, "date < ?", [c.now.date], "date DESC, COALESCE(meet_time, start_time, '99:99') DESC, id DESC", limit), today: c.now.date };
        }
        return { events: listEvents(c, "date >= ?", [c.now.date], "date, COALESCE(meet_time, start_time, '99:99'), id"), today: c.now.date };
      },
    ],
    ["GET", "/events/pending", pending],
    [
      "GET",
      "/events/next",
      (c) => {
        const e = c.db.one(
          `SELECT id FROM events WHERE date >= ? AND status = 'scheduled'
           ORDER BY date, COALESCE(meet_time, start_time, '99:99'), id LIMIT 1`,
          c.now.date,
        );
        return e ? eventDetail(c, e.id) : { event: null, today: c.now.date };
      },
    ],
    // 「前回の予定をコピー」用: 種類ごとに最後に作った予定（中止は後回し）
    [
      "GET",
      "/events/latest",
      (c) => {
        const type = v.oneOf(c.query.type, "種類", TYPES);
        const e = type
          ? c.db.one("SELECT * FROM events WHERE type = ? ORDER BY status = 'canceled', created_at DESC, id DESC LIMIT 1", type)
          : c.db.one("SELECT * FROM events ORDER BY status = 'canceled', created_at DESC, id DESC LIMIT 1");
        return { event: e || null };
      },
      { auth: "admin" },
    ],
    ["GET", "/events/:id", (c) => eventDetail(c, c.params.id)],
    [
      "POST",
      "/events",
      (c) => {
        const event = insertEvent(c, eventFields(c.body));
        c.emit("event.created", { event });
        return { event };
      },
      { auth: "admin" },
    ],
    ["PATCH", "/events/:id", updateEvent, { auth: "admin" }],
    [
      "POST",
      "/events/:id/cancel",
      (c) => {
        const before = getEvent(c.db, c.params.id);
        if (before.status === "canceled") return { event: before };
        c.db.run("UPDATE events SET status = 'canceled', updated_at = ? WHERE id = ?", c.now.ts, before.id);
        const event = getEvent(c.db, before.id);
        c.emit("event.canceled", { event });
        return { event };
      },
      { auth: "admin" },
    ],
    // 中止の取り消し
    [
      "POST",
      "/events/:id/restore",
      (c) => {
        const before = getEvent(c.db, c.params.id);
        if (before.status !== "canceled") return { event: before };
        c.db.run("UPDATE events SET status = 'scheduled', updated_at = ? WHERE id = ?", c.now.ts, before.id);
        const event = getEvent(c.db, before.id);
        c.emit("event.updated", { event, before });
        return { event };
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/events/:id",
      (c) => {
        const e = getEvent(c.db, c.params.id);
        if (c.db.one("SELECT id FROM games WHERE event_id = ? LIMIT 1", e.id)) {
          throw conflict("試合結果が登録されている予定は削除できません。中止にしてください");
        }
        c.db.tx(() => {
          c.db.run("DELETE FROM attendance WHERE event_id = ?", e.id);
          c.db.run("DELETE FROM events WHERE id = ?", e.id);
          c.db.run("UPDATE polls SET event_id = NULL WHERE event_id = ?", e.id);
        });
        return { ok: true };
      },
      { auth: "admin" },
    ],
    ["PUT", "/events/:id/rsvp", setRsvp],

    // ---------------- 球場
    ["GET", "/venues", (c) => ({ venues: c.db.all("SELECT * FROM venues ORDER BY name") })],
    [
      "POST",
      "/venues",
      (c) => {
        const f = venueFields(c.body);
        if (c.db.one("SELECT id FROM venues WHERE name = ?", f.name)) throw conflict("同じ名前の球場がすでにあります");
        const { lastId } = c.db.run(
          "INSERT INTO venues(name, address, url, note, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
          f.name,
          f.address,
          f.url,
          f.note,
          c.now.ts,
          c.now.ts,
        );
        return { venue: getVenue(c.db, lastId) };
      },
      { auth: "admin" },
    ],
    [
      "PATCH",
      "/venues/:id",
      (c) => {
        const cur = getVenue(c.db, c.params.id);
        const f = venueFields({ ...cur, ...c.body });
        if (c.db.one("SELECT id FROM venues WHERE name = ? AND id != ?", f.name, cur.id)) throw conflict("同じ名前の球場がすでにあります");
        c.db.run(
          "UPDATE venues SET name = ?, address = ?, url = ?, note = ?, updated_at = ? WHERE id = ?",
          f.name,
          f.address,
          f.url,
          f.note,
          c.now.ts,
          cur.id,
        );
        return { venue: getVenue(c.db, cur.id) };
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/venues/:id",
      (c) => {
        const cur = getVenue(c.db, c.params.id);
        c.db.run("DELETE FROM venues WHERE id = ?", cur.id);
        return { ok: true };
      },
      { auth: "admin" },
    ],

    // ---------------- 日程調整
    [
      "GET",
      "/polls",
      (c) => {
        const rows = c.db.all(
          `SELECT p.*,
             (SELECT COUNT(*) FROM poll_options o WHERE o.poll_id = p.id) AS option_count,
             (SELECT COUNT(*) FROM poll_answers x JOIN members m ON m.id = x.member_id WHERE x.poll_id = p.id AND m.active = 1) AS answer_count,
             EXISTS (SELECT 1 FROM poll_answers x WHERE x.poll_id = p.id AND x.member_id = ?) AS answered,
             (SELECT MIN(date) FROM poll_options o WHERE o.poll_id = p.id) AS first_date,
             (SELECT MAX(date) FROM poll_options o WHERE o.poll_id = p.id) AS last_date
           FROM polls p ORDER BY p.status = 'open' DESC, p.created_at DESC LIMIT 100`,
          c.member.id,
        );
        const memberCount = c.db.one("SELECT COUNT(*) AS n FROM members WHERE active = 1 AND is_guest = 0").n;
        return { polls: rows.map((p) => ({ ...p, answered: !!p.answered })), member_count: memberCount, today: c.now.date };
      },
    ],
    ["GET", "/polls/:id", (c) => pollDetail(c, c.params.id)],
    [
      "POST",
      "/polls",
      (c) => {
        const title = v.str(c.body.title, "タイトル", { max: 60, required: true });
        const note = v.str(c.body.note, "メモ", { max: 1000 });
        const deadline = v.date(c.body.deadline, "締切");
        const opts = optionFields(c.body.options);
        const id = c.db.tx(() => {
          const { lastId } = c.db.run(
            "INSERT INTO polls(title, note, deadline, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
            title,
            note,
            deadline,
            c.member.id,
            c.now.ts,
            c.now.ts,
          );
          opts.forEach((o, i) =>
            c.db.run("INSERT INTO poll_options(poll_id, date, time, note, sort) VALUES(?, ?, ?, ?, ?)", lastId, o.date, o.time, o.note, i),
          );
          return lastId;
        });
        const poll = getPoll(c.db, id);
        const options = pollOptions(c.db, id);
        c.emit("poll.created", { poll, options });
        return { poll, options };
      },
      { auth: "admin" },
    ],
    [
      "PATCH",
      "/polls/:id",
      (c) => {
        const p = getPoll(c.db, c.params.id);
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
          c.db.run(`UPDATE polls SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), c.now.ts, p.id);
        }
        return pollDetail(c, p.id);
      },
      { auth: "admin" },
    ],
    [
      "DELETE",
      "/polls/:id",
      (c) => {
        const p = getPoll(c.db, c.params.id);
        c.db.tx(() => {
          c.db.run("DELETE FROM poll_answers WHERE poll_id = ?", p.id);
          c.db.run("DELETE FROM poll_options WHERE poll_id = ?", p.id);
          c.db.run("DELETE FROM polls WHERE id = ?", p.id);
        });
        return { ok: true };
      },
      { auth: "admin" },
    ],
    [
      "PUT",
      "/polls/:id/answer",
      (c) => {
        const p = getPoll(c.db, c.params.id);
        const memberId = c.body.member_id ? v.int(c.body.member_id, "メンバー", { min: 1 }) : c.member.id;
        c.requireAdminOrSelf(memberId);
        if (!c.db.one("SELECT id FROM members WHERE id = ? AND active = 1", memberId)) throw notFound("メンバーが見つかりません");
        if (p.status !== "open") throw badRequest("この日程調整は締め切られました");
        if (!c.isAdmin && p.deadline && p.deadline < c.now.date) throw badRequest("回答の締切を過ぎています");
        const options = pollOptions(c.db, p.id);
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
        c.db.run(
          `INSERT INTO poll_answers(poll_id, member_id, answers, comment, updated_at) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(poll_id, member_id) DO UPDATE SET answers = excluded.answers, comment = excluded.comment, updated_at = excluded.updated_at`,
          p.id,
          memberId,
          JSON.stringify(answers),
          comment,
          c.now.ts,
        );
        return pollDetail(c, p.id);
      },
    ],
    // この日に決定 → 予定を作って締める
    [
      "POST",
      "/polls/:id/decide",
      (c) => {
        const p = getPoll(c.db, c.params.id);
        if (p.status === "decided") throw conflict("すでに決定しています");
        const optionId = v.int(c.body.option_id, "候補", { min: 1, required: true });
        const option = c.db.one("SELECT * FROM poll_options WHERE id = ? AND poll_id = ?", optionId, p.id);
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
        const event = c.db.tx(() => {
          const e = insertEvent(c, f);
          c.db.run(
            "UPDATE polls SET status = 'decided', decided_option_id = ?, event_id = ?, updated_at = ? WHERE id = ?",
            option.id,
            e.id,
            c.now.ts,
            p.id,
          );
          return e;
        });
        const poll = getPoll(c.db, p.id);
        c.emit("poll.decided", { poll, event });
        return { poll, event };
      },
      { auth: "admin" },
    ],

    // ---------------- カレンダー購読
    [
      "GET",
      "/ics/:token",
      (c) => {
        if (!safeEqual(c.params.token, c.settings.icsToken)) throw notFound("カレンダーが見つかりません");
        const events = c.db.all("SELECT * FROM events WHERE date >= ? ORDER BY date, id", addDays(c.now.date, -365));
        return raw(buildIcs(c, events), {
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
