// community 機能: お知らせ（notices）・起床報告（wakeups）・練習報告（practices）
// LINE のトークで流れて埋もれていた「連絡」「起きました！」「練習報告」をアプリ内に置き換える。
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";
import { addDays, toTs } from "../time.js";
import { publicMember } from "./members.js";

// ---------------------------------------------------------------- 定数
export const NOTICE_CATEGORIES = ["info", "important", "chat"]; // 連絡 / 重要 / 雑談
export const PRACTICE_KINDS = ["swing", "run", "catch", "knock", "batting", "training", "pitching", "other"];
export const PRACTICE_UNITS = ["回", "km", "分", "球", "セット"];
const WAKE_STAGES = ["woke", "left", "arrived", "late"];

const migrations = [
  {
    id: "community-001",
    sql: `
-- お知らせ
CREATE TABLE IF NOT EXISTS notices (
  id BIGSERIAL PRIMARY KEY,
  author_id BIGINT NOT NULL,
  category TEXT NOT NULL DEFAULT 'info', -- info（連絡） / important（重要） / chat（雑談）
  title TEXT,
  body TEXT NOT NULL,
  pinned BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_created ON notices(created_at);

-- お知らせの既読・了解（開いたら read_at、「了解！」で ack_at）
CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  read_at BIGINT NOT NULL,
  ack_at BIGINT,
  PRIMARY KEY (notice_id, member_id)
);

-- 起床報告（予定×メンバーで1行。at = 起床時刻）
CREATE TABLE IF NOT EXISTS wakeups (
  event_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  at BIGINT NOT NULL,                   -- 起きた時刻（epoch ms）
  comment TEXT,                          -- 最新のひとこと
  left_at BIGINT,                       -- 出発
  arrived_at BIGINT,                    -- 到着
  late_minutes BIGINT,                  -- 遅れる見込み（分）
  late_at BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS wakeups_event ON wakeups(event_id, at);

-- 練習報告
CREATE TABLE IF NOT EXISTS practices (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL,
  date TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',      -- JSON [{kind, amount, unit}]
  comment TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS practices_date ON practices(date);
CREATE INDEX IF NOT EXISTS practices_member ON practices(member_id, date);

CREATE TABLE IF NOT EXISTS practice_likes (
  practice_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (practice_id, member_id)
);
`,
  },
];

// ---------------------------------------------------------------- 共通
const membersById = (db) => {
  const map = new Map();
  for (const m of db.all("SELECT * FROM members")) map.set(m.id, publicMember(m));
  return map;
};
// お知らせの対象者（LINE 連携済みの在籍メンバー）
const audience = (db) => db.all("SELECT * FROM members WHERE active = 1 AND line_user_id IS NOT NULL ORDER BY id");

const idParam = (val, label = "ID") => v.int(val, label, { min: 1, max: 1e12, required: true });

// ================================================================ お知らせ
function getNotice(db, id) {
  const n = db.one("SELECT * FROM notices WHERE id = ?", idParam(id));
  if (!n) throw notFound("お知らせが見つかりません");
  return n;
}

function noticeFields(c, body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.category !== undefined) out.category = v.oneOf(body.category || "info", "カテゴリ", NOTICE_CATEGORIES);
  if (!partial || body.title !== undefined) out.title = v.str(body.title, "タイトル", { max: 60 });
  if (!partial || body.body !== undefined) {
    // 改行は保持したいので trim は前後のみ
    out.body = v.str(body.body, "本文", { max: 2000, required: true });
  }
  if (!partial || body.pinned !== undefined) out.pinned = body.pinned ? 1 : 0;
  if (!c.isAdmin) {
    if (out.pinned) throw forbidden("ピン留めは管理者だけができます");
    if (out.category === "important") throw forbidden("「重要」は管理者だけが使えます");
  }
  return out;
}

function noticeView(db, n, me, { members, total, stats } = {}) {
  members ??= membersById(db);
  const s = stats?.get(n.id) || db.one(
    "SELECT COUNT(*) AS reads, COUNT(ack_at) AS acks FROM notice_reads r JOIN members m ON m.id = r.member_id WHERE r.notice_id = ? AND m.active = 1",
    n.id,
  );
  const mine = db.one("SELECT read_at, ack_at FROM notice_reads WHERE notice_id = ? AND member_id = ?", n.id, me.id);
  return {
    id: n.id,
    category: n.category,
    title: n.title || "",
    body: n.body,
    pinned: !!n.pinned,
    author: members.get(n.author_id) || null,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    edited: n.updated_at > n.created_at,
    readCount: s?.reads || 0,
    ackCount: s?.acks || 0,
    total: total ?? audience(db).length,
    read: !!mine,
    acked: !!mine?.ack_at,
  };
}

function listNotices(c) {
  const limit = v.int(c.query.limit, "件数", { min: 1, max: 100 }) ?? 50;
  const rows = c.db.all("SELECT * FROM notices ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?", limit);
  const members = membersById(c.db);
  const total = audience(c.db).length;
  const stats = new Map(
    c.db
      .all(
        `SELECT r.notice_id AS id, COUNT(*) AS reads, COUNT(r.ack_at) AS acks
         FROM notice_reads r JOIN members m ON m.id = r.member_id WHERE m.active = 1 GROUP BY r.notice_id`,
      )
      .map((r) => [r.id, r]),
  );
  const notices = rows.map((n) => noticeView(c.db, n, c.member, { members, total, stats }));
  const unread = c.db.one(
    `SELECT COUNT(*) AS n FROM notices n
     WHERE NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.member_id = ?)`,
    c.member.id,
  ).n;
  return { notices, unread };
}

function markRead(db, noticeId, memberId, ts, { ack = false } = {}) {
  db.run(
    `INSERT INTO notice_reads(notice_id, member_id, read_at, ack_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(notice_id, member_id) DO UPDATE SET ack_at = COALESCE(notice_reads.ack_at, excluded.ack_at)`,
    noticeId,
    memberId,
    ts,
    ack ? ts : null,
  );
}

function noticeDetail(c, n) {
  const members = membersById(c.db);
  const reads = new Map(c.db.all("SELECT * FROM notice_reads WHERE notice_id = ?", n.id).map((r) => [r.member_id, r]));
  const acked = [];
  const readOnly = [];
  const unread = [];
  for (const m of audience(c.db)) {
    const r = reads.get(m.id);
    const pm = members.get(m.id);
    if (r?.ack_at) acked.push({ ...pm, at: r.ack_at });
    else if (r) readOnly.push(pm);
    else unread.push(pm);
  }
  acked.sort((a, b) => a.at - b.at);
  return {
    notice: noticeView(c.db, n, c.member, { members }),
    acked,
    notAcked: [...readOnly.map((m) => ({ ...m, read: true })), ...unread.map((m) => ({ ...m, read: false }))],
    canEdit: c.isAdmin || n.author_id === c.member.id,
  };
}

const noticeRoutes = [
  ["GET", "/notices", listNotices],

  // ホームカード用: 自分がまだ了解していない最新のお知らせ
  [
    "GET",
    "/notices/pending",
    (c) => {
      const rows = c.db.all(
        `SELECT n.* FROM notices n
         WHERE n.author_id != ? AND NOT EXISTS (
           SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.member_id = ? AND r.ack_at IS NOT NULL)
         ORDER BY n.created_at DESC, n.id DESC`,
        c.member.id,
        c.member.id,
      );
      return { count: rows.length, notice: rows[0] ? noticeView(c.db, rows[0], c.member) : null };
    },
  ],

  [
    "POST",
    "/notices",
    (c) => {
      const f = noticeFields(c, c.body);
      const { lastId } = c.db.run(
        "INSERT INTO notices(author_id, category, title, body, pinned, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        c.member.id,
        f.category,
        f.title,
        f.body,
        f.pinned,
        c.now.ts,
        c.now.ts,
      );
      // 投稿者は既読・了解済み扱い
      markRead(c.db, lastId, c.member.id, c.now.ts, { ack: true });
      const row = getNotice(c.db, lastId);
      const notice = noticeView(c.db, row, c.member);
      c.emit("notice.created", { notice, author: publicMember(c.member) });
      return { notice };
    },
  ],

  // 開いたら既読
  [
    "GET",
    "/notices/:id",
    (c) => {
      const n = getNotice(c.db, c.params.id);
      markRead(c.db, n.id, c.member.id, c.now.ts);
      return noticeDetail(c, n);
    },
  ],

  [
    "PATCH",
    "/notices/:id",
    (c) => {
      const n = getNotice(c.db, c.params.id);
      if (!c.isAdmin && n.author_id !== c.member.id) throw forbidden("投稿者か管理者だけが編集できます");
      const f = noticeFields(c, c.body, { partial: true });
      // メンバーが自分の投稿を編集するとき、管理者が付けたピン・重要は保持する
      if (!c.isAdmin) {
        delete f.pinned;
        if (f.category === undefined || n.category === "important") delete f.category;
      }
      const keys = Object.keys(f);
      if (keys.length) {
        c.db.run(
          `UPDATE notices SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          ...keys.map((k) => f[k]),
          c.now.ts,
          n.id,
        );
      }
      return noticeDetail(c, getNotice(c.db, n.id));
    },
  ],

  [
    "DELETE",
    "/notices/:id",
    (c) => {
      const n = getNotice(c.db, c.params.id);
      if (!c.isAdmin && n.author_id !== c.member.id) throw forbidden("投稿者か管理者だけが削除できます");
      c.db.tx(() => {
        c.db.run("DELETE FROM notice_reads WHERE notice_id = ?", n.id);
        c.db.run("DELETE FROM notices WHERE id = ?", n.id);
      });
      return { ok: true };
    },
  ],

  // 「了解！」
  [
    "POST",
    "/notices/:id/ack",
    (c) => {
      const n = getNotice(c.db, c.params.id);
      markRead(c.db, n.id, c.member.id, c.now.ts, { ack: true });
      return { notice: noticeView(c.db, n, c.member) };
    },
  ],
  [
    "DELETE",
    "/notices/:id/ack",
    (c) => {
      const n = getNotice(c.db, c.params.id);
      c.db.run("UPDATE notice_reads SET ack_at = NULL WHERE notice_id = ? AND member_id = ?", n.id, c.member.id);
      return { notice: noticeView(c.db, n, c.member) };
    },
  ],
];

// ================================================================ 起床報告
const meetTime = (e) => e.meet_time || e.start_time || null;

function getEvent(db, id) {
  const e = db.one("SELECT * FROM events WHERE id = ?", idParam(id, "予定"));
  if (!e) throw notFound("予定が見つかりません");
  return e;
}

function wakeView(w, rank) {
  if (!w) return null;
  return {
    at: w.at,
    rank,
    comment: w.comment || "",
    leftAt: w.left_at || null,
    arrivedAt: w.arrived_at || null,
    lateMinutes: w.late_minutes ?? null,
    lateAt: w.late_at || null,
  };
}

const eventView = (e) => ({
  id: e.id,
  type: e.type,
  title: e.title,
  date: e.date,
  meetTime: e.meet_time || "",
  startTime: e.start_time || "",
  venue: e.venue || "",
  meetPlace: e.meet_place || "",
  status: e.status,
});

function eventBoard(c, e) {
  const wakes = c.db.all("SELECT * FROM wakeups WHERE event_id = ? ORDER BY at, rowid", e.id);
  const rankOf = new Map(wakes.map((w, i) => [w.member_id, i + 1]));
  const wakeOf = new Map(wakes.map((w) => [w.member_id, w]));
  const att = new Map(c.db.all("SELECT member_id, status FROM attendance WHERE event_id = ?", e.id).map((a) => [a.member_id, a.status]));
  const rows = c.db.all("SELECT * FROM members WHERE active = 1 OR id IN (SELECT member_id FROM wakeups WHERE event_id = ?)", e.id);
  const people = [];
  for (const m of rows) {
    const status = att.get(m.id) || null;
    const w = wakeOf.get(m.id);
    // 助っ人（LINE 未連携）は出席予定のときだけ表示
    if (!m.line_user_id && status !== "yes" && !w) continue;
    people.push({ member: publicMember(m), attendance: status, wakeup: wakeView(w, rankOf.get(m.id)) });
  }
  const attending = people.filter((p) => p.attendance === "yes");
  const meet = meetTime(e);
  const startTs = e.start_time ? toTs(e.date, e.start_time) : toTs(addDays(e.date, 1));
  const mine = wakeOf.get(c.member.id);
  return {
    event: eventView(e),
    now: c.now.ts,
    isToday: e.date === c.now.date,
    open: canWake(c, e),
    beforeStart: e.date === c.now.date && c.now.ts < startTs,
    meetAt: meet ? toTs(e.date, meet) : null,
    people,
    counts: {
      attending: attending.length,
      // 出席予定の人のうち起きた人
      wokeAttending: attending.filter((p) => p.wakeup).length,
      woke: wakes.length,
      left: wakes.filter((w) => w.left_at).length,
      arrived: wakes.filter((w) => w.arrived_at).length,
    },
    me: { attendance: att.get(c.member.id) || null, wakeup: wakeView(mine, rankOf.get(c.member.id)) },
  };
}

const canWake = (c, e) => e.status === "scheduled" && e.date === c.now.date;

function todayEvents(c) {
  return c.db.all(
    "SELECT * FROM events WHERE date = ? AND status = 'scheduled' ORDER BY COALESCE(meet_time, start_time, '99:99'), id",
    c.now.date,
  );
}

function ranking(c) {
  const season = v.int(c.query.season, "年度", { min: 2000, max: 2100 }) ?? Number(c.settings.season);
  const events = c.db.all(
    "SELECT * FROM events WHERE status = 'scheduled' AND date >= ? AND date <= ? AND id IN (SELECT event_id FROM wakeups)",
    `${season}-01-01`,
    `${season}-12-31`,
  );
  const stat = new Map();
  for (const e of events) {
    const wakes = c.db.all("SELECT * FROM wakeups WHERE event_id = ? ORDER BY at, rowid", e.id);
    const meet = meetTime(e);
    const meetTs = meet ? toTs(e.date, meet) : null;
    wakes.forEach((w, i) => {
      const s = stat.get(w.member_id) || { count: 0, firsts: 0, beforeSum: 0, beforeN: 0, timeSum: 0 };
      s.count++;
      if (i === 0) s.firsts++;
      if (meetTs) {
        s.beforeSum += (meetTs - w.at) / 60000;
        s.beforeN++;
      }
      // 起床時刻（その日の 0:00 から何分か）
      s.timeSum += (w.at - toTs(e.date)) / 60000;
      stat.set(w.member_id, s);
    });
  }
  const members = membersById(c.db);
  const list = [...stat.entries()]
    .map(([id, s]) => ({
      member: members.get(id),
      count: s.count,
      firsts: s.firsts,
      avgBefore: s.beforeN ? Math.round(s.beforeSum / s.beforeN) : null, // 集合の何分前に起きたか（平均）
      avgTime: Math.round(s.timeSum / s.count), // 平均起床時刻（分）
    }))
    .filter((r) => r.member)
    .sort((a, b) => b.firsts - a.firsts || (b.avgBefore ?? -1e9) - (a.avgBefore ?? -1e9) || a.avgTime - b.avgTime);
  return { season, events: events.length, ranking: list };
}

const wakeRoutes = [
  [
    "GET",
    "/wakeups/today",
    (c) => ({ date: c.now.date, now: c.now.ts, events: todayEvents(c).map((e) => eventBoard(c, e)) }),
  ],
  ["GET", "/wakeups/ranking", ranking],

  // 開発用: 今日の練習予定を1件作る（ALLOW_MOCK のときだけ）
  [
    "POST",
    "/wakeups/dev-event",
    (c) => {
      if (c.env.ALLOW_MOCK !== "true") throw notFound("APIが見つかりません");
      const [h] = c.now.time.split(":").map(Number);
      const pad = (n) => String(Math.min(23, n)).padStart(2, "0");
      const { lastId } = c.db.run(
        `INSERT INTO events(type, title, date, meet_time, start_time, venue, status, created_by, created_at, updated_at)
         VALUES('practice', '朝練（開発用）', ?, ?, ?, '河川敷グラウンド', 'scheduled', ?, ?, ?)`,
        c.now.date,
        `${pad(h + 2)}:00`,
        `${pad(h + 2)}:30`,
        c.member.id,
        c.now.ts,
        c.now.ts,
      );
      // 在籍メンバーを全員「出席」にしておく
      for (const m of c.db.all("SELECT id FROM members WHERE active = 1")) {
        c.db.run("INSERT OR IGNORE INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, 'yes', ?)", lastId, m.id, c.now.ts);
      }
      return { event: eventView(getEvent(c.db, lastId)) };
    },
    { auth: "admin" },
  ],

  ["GET", "/wakeups/:eventId", (c) => eventBoard(c, getEvent(c.db, c.params.eventId))],

  [
    "POST",
    "/wakeups/:eventId",
    (c) => {
      const e = getEvent(c.db, c.params.eventId);
      if (e.status !== "scheduled") throw badRequest("中止になった予定です");
      if (e.date !== c.now.date) throw badRequest("起床報告は予定の当日だけできます");
      const stage = v.oneOf(c.body.stage, "報告の種類", WAKE_STAGES, { required: true });
      const comment = v.str(c.body.comment, "ひとこと", { max: 100 });
      const lateMinutes = stage === "late" ? v.int(c.body.lateMinutes, "遅れる時間", { min: 1, max: 600, required: true }) : null;

      const existing = c.db.one("SELECT * FROM wakeups WHERE event_id = ? AND member_id = ?", e.id, c.member.id);
      const ts = c.now.ts;
      let created = false;
      if (!existing) {
        // 出発・到着・遅刻の報告でも「起きた」ことになる
        c.db.run(
          "INSERT INTO wakeups(event_id, member_id, at, comment, updated_at) VALUES(?, ?, ?, ?, ?)",
          e.id,
          c.member.id,
          ts,
          comment,
          ts,
        );
        created = true;
      } else if (stage === "woke") {
        throw conflict("もう起床報告ずみです", "already_woke");
      }
      const set = { updated_at: ts };
      if (comment && !created) set.comment = comment;
      if (stage === "left") set.left_at = existing?.left_at || ts;
      if (stage === "arrived") {
        set.arrived_at = existing?.arrived_at || ts;
        if (!existing?.left_at) set.left_at = ts;
      }
      if (stage === "late") {
        set.late_minutes = lateMinutes;
        set.late_at = ts;
      }
      const keys = Object.keys(set);
      c.db.run(
        `UPDATE wakeups SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE event_id = ? AND member_id = ?`,
        ...keys.map((k) => set[k]),
        e.id,
        c.member.id,
      );
      const board = eventBoard(c, e);
      if (created) {
        const wakeup = c.db.one("SELECT * FROM wakeups WHERE event_id = ? AND member_id = ?", e.id, c.member.id);
        c.emit("wakeup.created", { wakeup, member: publicMember(c.member), event: e });
      }
      return { ...board, created, rank: board.me.wakeup.rank };
    },
  ],

  // 押し間違いの取り消し（stage を指定するとその段階だけ取り消す）
  [
    "DELETE",
    "/wakeups/:eventId",
    (c) => {
      const e = getEvent(c.db, c.params.eventId);
      if (e.date !== c.now.date) throw badRequest("当日だけ取り消せます");
      const stage = v.oneOf(c.query.stage || c.body?.stage, "報告の種類", WAKE_STAGES);
      if (!stage || stage === "woke") {
        c.db.run("DELETE FROM wakeups WHERE event_id = ? AND member_id = ?", e.id, c.member.id);
      } else {
        const col = { left: "left_at = NULL, arrived_at = NULL", arrived: "arrived_at = NULL", late: "late_minutes = NULL, late_at = NULL" }[stage];
        c.db.run(`UPDATE wakeups SET ${col}, updated_at = ? WHERE event_id = ? AND member_id = ?`, c.now.ts, e.id, c.member.id);
      }
      return eventBoard(c, e);
    },
  ],
];

// ================================================================ 練習報告
function practiceItems(list) {
  if (!Array.isArray(list) || !list.length) throw badRequest("練習メニューを1つ以上選んでください");
  if (list.length > 12) throw badRequest("練習メニューは12個までにしてください");
  return list.map((it) => {
    const kind = v.oneOf(it?.kind, "練習の種類", PRACTICE_KINDS, { required: true });
    const unit = v.oneOf(it?.unit, "単位", PRACTICE_UNITS, { required: true });
    const n = Number(it?.amount);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw badRequest("練習の量の値が不正です");
    const out = { kind, amount: Math.round(n * 10) / 10, unit };
    if (kind === "other") out.label = v.str(it.label, "練習の名前", { max: 20 }) || "その他";
    return out;
  });
}

function practiceFields(c, body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.date !== undefined) {
    const date = v.date(body.date, "日付") || c.now.date;
    if (date > c.now.date) throw badRequest("未来の日付は記録できません");
    if (date < addDays(c.now.date, -366)) throw badRequest("1年以上前の日付は記録できません");
    out.date = date;
  }
  if (!partial || body.items !== undefined) out.items = JSON.stringify(practiceItems(body.items));
  if (!partial || body.comment !== undefined) out.comment = v.str(body.comment, "ひとこと", { max: 300 });
  return out;
}

function getPractice(db, id) {
  const p = db.one("SELECT * FROM practices WHERE id = ?", idParam(id));
  if (!p) throw notFound("練習報告が見つかりません");
  return p;
}

function practiceView(db, p, me, members = membersById(db)) {
  const likes = db.all("SELECT member_id FROM practice_likes WHERE practice_id = ? ORDER BY at", p.id);
  return {
    id: p.id,
    member: members.get(p.member_id) || null,
    date: p.date,
    items: JSON.parse(p.items || "[]"),
    comment: p.comment || "",
    createdAt: p.created_at,
    likeCount: likes.length,
    liked: likes.some((l) => l.member_id === me.id),
    likers: likes.map((l) => members.get(l.member_id)).filter(Boolean),
    mine: p.member_id === me.id,
  };
}

// 連続日数: 今日（まだなら昨日）から遡って練習した日が続いている日数
export function streakOf(dates, today) {
  const set = new Set(dates);
  let d = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

function bestStreak(dates) {
  const sorted = [...new Set(dates)].sort();
  let best = 0;
  let cur = 0;
  let prev = null;
  for (const d of sorted) {
    cur = prev && addDays(prev, 1) === d ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  return best;
}

const sumKind = (rows, kind, unit) =>
  rows.reduce((s, p) => s + JSON.parse(p.items || "[]").filter((i) => i.kind === kind && i.unit === unit).reduce((a, i) => a + i.amount, 0), 0);

function monthRanking(c) {
  const month = c.query.month || c.now.date.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("月の形式が不正です");
  const rows = c.db.all("SELECT * FROM practices WHERE date >= ? AND date <= ?", `${month}-01`, `${month}-31`);
  const by = new Map();
  for (const p of rows) {
    const list = by.get(p.member_id) || [];
    list.push(p);
    by.set(p.member_id, list);
  }
  const members = membersById(c.db);
  const ranking = [...by.entries()]
    .map(([id, list]) => ({
      member: members.get(id),
      days: new Set(list.map((p) => p.date)).size,
      posts: list.length,
      swings: Math.round(sumKind(list, "swing", "回")),
      runKm: Math.round(sumKind(list, "run", "km") * 10) / 10,
    }))
    .filter((r) => r.member);
  return {
    month,
    days: [...ranking].sort((a, b) => b.days - a.days || b.posts - a.posts),
    swings: ranking.filter((r) => r.swings > 0).sort((a, b) => b.swings - a.swings),
    run: ranking.filter((r) => r.runKm > 0).sort((a, b) => b.runKm - a.runKm),
  };
}

function practiceSummary(c, memberId) {
  const today = c.now.date;
  const since = addDays(today, -400);
  const rows = c.db.all("SELECT * FROM practices WHERE member_id = ? AND date >= ? ORDER BY date", memberId, since);
  const dates = rows.map((p) => p.date);
  const days = {};
  for (const p of rows) days[p.date] = (days[p.date] || 0) + 1;
  // ヒートマップ: 直近12週（日曜はじまり。今週の土曜まで）
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const start = addDays(today, -dow - 7 * 11);
  const calendar = [];
  for (let i = 0; i < 84; i++) {
    const date = addDays(start, i);
    calendar.push({ date, count: days[date] || 0, future: date > today });
  }
  const month = today.slice(0, 7);
  const monthRows = rows.filter((p) => p.date.startsWith(month));
  return {
    today,
    streak: streakOf(dates, today),
    bestStreak: bestStreak(dates),
    practicedToday: !!days[today],
    monthDays: new Set(monthRows.map((p) => p.date)).size,
    monthSwings: Math.round(sumKind(monthRows, "swing", "回")),
    monthRunKm: Math.round(sumKind(monthRows, "run", "km") * 10) / 10,
    totalDays: new Set(dates).size,
    calendar,
  };
}

const practiceRoutes = [
  [
    "GET",
    "/practices",
    (c) => {
      const limit = v.int(c.query.limit, "件数", { min: 1, max: 100 }) ?? 30;
      const before = v.int(c.query.before, "ID", { min: 1, max: 1e12 });
      const memberId = v.int(c.query.member, "メンバー", { min: 1, max: 1e12 });
      const where = [];
      const params = [];
      if (before) where.push("id < ?"), params.push(before);
      if (memberId) where.push("member_id = ?"), params.push(memberId);
      const rows = c.db.all(
        `SELECT * FROM practices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC, id DESC LIMIT ?`,
        ...params,
        limit + 1,
      );
      const members = membersById(c.db);
      return {
        practices: rows.slice(0, limit).map((p) => practiceView(c.db, p, c.member, members)),
        hasMore: rows.length > limit,
      };
    },
  ],
  ["GET", "/practices/ranking", monthRanking],
  [
    "GET",
    "/practices/summary",
    (c) => {
      const id = v.int(c.query.member, "メンバー", { min: 1, max: 1e12 }) ?? c.member.id;
      return practiceSummary(c, id);
    },
  ],
  [
    "POST",
    "/practices",
    (c) => {
      const f = practiceFields(c, c.body);
      const { lastId } = c.db.run(
        "INSERT INTO practices(member_id, date, items, comment, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
        c.member.id,
        f.date,
        f.items,
        f.comment,
        c.now.ts,
        c.now.ts,
      );
      const row = getPractice(c.db, lastId);
      const practice = practiceView(c.db, row, c.member);
      c.emit("practice.created", { practice, member: publicMember(c.member) });
      return { practice, summary: practiceSummary(c, c.member.id) };
    },
  ],
  ["GET", "/practices/:id", (c) => ({ practice: practiceView(c.db, getPractice(c.db, c.params.id), c.member) })],
  [
    "PATCH",
    "/practices/:id",
    (c) => {
      const p = getPractice(c.db, c.params.id);
      if (p.member_id !== c.member.id) throw forbidden("自分の練習報告だけ編集できます");
      const f = practiceFields(c, c.body, { partial: true });
      const keys = Object.keys(f);
      if (keys.length) {
        c.db.run(
          `UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          ...keys.map((k) => f[k]),
          c.now.ts,
          p.id,
        );
      }
      return { practice: practiceView(c.db, getPractice(c.db, p.id), c.member) };
    },
  ],
  [
    "DELETE",
    "/practices/:id",
    (c) => {
      const p = getPractice(c.db, c.params.id);
      if (p.member_id !== c.member.id && !c.isAdmin) throw forbidden("自分の練習報告だけ削除できます");
      c.db.tx(() => {
        c.db.run("DELETE FROM practice_likes WHERE practice_id = ?", p.id);
        c.db.run("DELETE FROM practices WHERE id = ?", p.id);
      });
      return { ok: true };
    },
  ],
  [
    "POST",
    "/practices/:id/like",
    (c) => {
      const p = getPractice(c.db, c.params.id);
      const { changes } = c.db.run(
        "INSERT OR IGNORE INTO practice_likes(practice_id, member_id, at) VALUES(?, ?, ?)",
        p.id,
        c.member.id,
        c.now.ts,
      );
      if (!changes) throw conflict("もうナイス！しています", "already_liked");
      return { practice: practiceView(c.db, p, c.member) };
    },
  ],
  [
    "DELETE",
    "/practices/:id/like",
    (c) => {
      const p = getPractice(c.db, c.params.id);
      c.db.run("DELETE FROM practice_likes WHERE practice_id = ? AND member_id = ?", p.id, c.member.id);
      return { practice: practiceView(c.db, p, c.member) };
    },
  ],
];

export default {
  name: "community",
  migrations,
  routes: [...noticeRoutes, ...wakeRoutes, ...practiceRoutes],
};
