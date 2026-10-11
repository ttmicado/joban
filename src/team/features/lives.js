// お笑いライブ（チームの芸人コンビ「アミダライン」など）の告知と、選手の参加意思
import { badRequest, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";

const STATUSES = ["go", "maybe", "no"]; // 行く / 迷い中 / 行けない

async function getLive(db, id) {
  const row = await db.one("SELECT * FROM lives WHERE id = ?", Number(id));
  if (!row) throw notFound("ライブが見つかりません");
  return row;
}

function liveFields(b, { partial = false } = {}) {
  const out = {};
  const set = (key, val) => {
    if (!partial || b[key] !== undefined) out[key] = val();
  };
  set("title", () => v.str(b.title, "タイトル", { max: 60, required: true }));
  set("performer", () => v.str(b.performer, "出演", { max: 60 }) ?? "アミダライン");
  set("date", () => v.date(b.date, "日付", { required: true }));
  set("open_time", () => v.time(b.open_time, "開場"));
  set("start_time", () => v.time(b.start_time, "開演"));
  set("end_time", () => v.time(b.end_time, "終演"));
  set("venue", () => v.str(b.venue, "会場", { max: 60, required: true }));
  set("venue_url", () => v.url(b.venue_url, "地図URL"));
  set("price_advance", () => v.int(b.price_advance, "前売料金", { min: 0, max: 1000000 }));
  set("price_door", () => v.int(b.price_door, "当日料金", { min: 0, max: 1000000 }));
  set("price_note", () => v.str(b.price_note, "料金のメモ", { max: 100 }));
  set("ticket_url", () => v.url(b.ticket_url, "チケットURL"));
  set("note", () => v.str(b.note, "メモ", { max: 1000 }));
  return out;
}

async function liveView(db, row, me) {
  const rsvps = await db.all(
    `SELECT r.*, m.name, m.picture, m.number, m.title AS member_title, m.is_guest, m.active, m.line_user_id, m.role, m.positions, m.throws, m.bats
       FROM live_rsvps r JOIN members m ON m.id = r.member_id
      WHERE r.live_id = ? ORDER BY r.updated_at, r.member_id`,
    row.id,
  );
  const list = rsvps.map((r) => ({
    member: publicMember({ ...r, id: r.member_id, title: r.member_title }),
    status: r.status,
    tickets: r.tickets,
    comment: r.comment || "",
  }));
  const mine = list.find((x) => x.member.id === me?.id) || null;
  const answered = new Set(list.map((x) => x.member.id));
  const unanswered = (await db.all("SELECT * FROM members WHERE active = 1 AND is_guest = 0 ORDER BY id"))
    .filter((m) => !answered.has(m.id))
    .map(publicMember);
  const go = list.filter((x) => x.status === "go");
  return {
    id: row.id,
    title: row.title,
    performer: row.performer || "",
    date: row.date,
    openTime: row.open_time || "",
    startTime: row.start_time || "",
    endTime: row.end_time || "",
    venue: row.venue || "",
    venueUrl: row.venue_url || "",
    priceAdvance: row.price_advance,
    priceDoor: row.price_door,
    priceNote: row.price_note || "",
    ticketUrl: row.ticket_url || "",
    note: row.note || "",
    status: row.status,
    createdBy: row.created_by,
    canEdit: !!me && (me.role === "admin" || me.id === row.created_by),
    counts: {
      go: go.length,
      maybe: list.filter((x) => x.status === "maybe").length,
      no: list.filter((x) => x.status === "no").length,
      unanswered: unanswered.length,
      // 取り置きをお願いしたい枚数（行く人の合計）
      tickets: go.reduce((n, x) => n + (x.tickets || 0), 0),
    },
    rsvps: list,
    unanswered,
    my: mine ? { status: mine.status, tickets: mine.tickets, comment: mine.comment } : null,
  };
}

export default {
  name: "lives",
  migrations: [
    {
      id: "lives-001",
      sql: `
CREATE TABLE IF NOT EXISTS lives (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  performer TEXT,                        -- 出演（既定: アミダライン）
  date TEXT NOT NULL,
  open_time TEXT,                        -- 開場
  start_time TEXT,                       -- 開演
  end_time TEXT,
  venue TEXT NOT NULL,                   -- 会場
  venue_url TEXT,
  price_advance BIGINT,                  -- 前売（円）
  price_door BIGINT,                     -- 当日（円）
  price_note TEXT,                       -- 料金のメモ（ドリンク代別など）
  ticket_url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled / canceled
  created_by BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS lives_date ON lives(date);

-- 選手の参加意思（行く / 迷い中 / 行けない）と取り置きしたいチケット枚数
CREATE TABLE IF NOT EXISTS live_rsvps (
  live_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  tickets BIGINT NOT NULL DEFAULT 0,
  comment TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (live_id, member_id)
);
`,
    },
  ],
  routes: [
    [
      "GET",
      "/lives",
      async (c) => {
        const past = c.query.range === "past";
        const rows = await c.db.all(
          past
            ? "SELECT * FROM lives WHERE date < ? ORDER BY date DESC, start_time DESC NULLS LAST, id DESC LIMIT 50"
            : "SELECT * FROM lives WHERE date >= ? ORDER BY date, start_time NULLS LAST, id",
          c.now.date,
        );
        const lives = [];
        for (const r of rows) lives.push(await liveView(c.db, r, c.member));
        return { lives };
      },
    ],
    ["GET", "/lives/:id", async (c) => ({ live: await liveView(c.db, await getLive(c.db, c.params.id), c.member) })],
    [
      "POST",
      "/lives",
      async (c) => {
        const f = liveFields(c.body);
        const { lastId } = await c.db.run(
          `INSERT INTO lives(title, performer, date, open_time, start_time, end_time, venue, venue_url,
             price_advance, price_door, price_note, ticket_url, note, created_by, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          f.title, f.performer, f.date, f.open_time, f.start_time, f.end_time, f.venue, f.venue_url,
          f.price_advance, f.price_door, f.price_note, f.ticket_url, f.note, c.member.id, c.now.ts, c.now.ts,
        );
        const live = await liveView(c.db, await getLive(c.db, lastId), c.member);
        c.emit("live.created", { live });
        return { live };
      },
    ],
    [
      "PATCH",
      "/lives/:id",
      async (c) => {
        const row = await getLive(c.db, c.params.id);
        if (!c.isAdmin && row.created_by !== c.member.id) throw forbidden("登録した人か管理者だけが編集できます");
        const f = liveFields(c.body, { partial: true });
        if (c.body.status !== undefined) f.status = v.oneOf(c.body.status, "状態", ["scheduled", "canceled"], { required: true });
        const keys = Object.keys(f);
        if (keys.length) {
          await c.db.run(
            `UPDATE lives SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
            ...keys.map((k) => f[k]),
            c.now.ts,
            row.id,
          );
        }
        return { live: await liveView(c.db, await getLive(c.db, row.id), c.member) };
      },
    ],
    [
      "DELETE",
      "/lives/:id",
      async (c) => {
        const row = await getLive(c.db, c.params.id);
        if (!c.isAdmin && row.created_by !== c.member.id) throw forbidden("登録した人か管理者だけが削除できます");
        await c.db.run("DELETE FROM live_rsvps WHERE live_id = ?", row.id);
        await c.db.run("DELETE FROM lives WHERE id = ?", row.id);
        return { ok: true };
      },
    ],
    // 参加意思（本人。管理者は member_id 指定で代理入力）
    [
      "PUT",
      "/lives/:id/rsvp",
      async (c) => {
        const row = await getLive(c.db, c.params.id);
        if (row.status === "canceled") throw badRequest("中止になったライブです");
        let memberId = c.member.id;
        if (c.body.member_id !== undefined && c.body.member_id !== null) {
          memberId = v.int(c.body.member_id, "メンバー", { min: 1, max: 1e12, required: true });
          c.requireAdminOrSelf(memberId);
          if (!(await c.db.one("SELECT id FROM members WHERE id = ?", memberId))) throw notFound("メンバーが見つかりません");
        }
        const status = v.oneOf(c.body.status, "参加意思", STATUSES, { required: true });
        const tickets = status === "go" ? (v.int(c.body.tickets, "取り置き枚数", { min: 0, max: 20 }) ?? 1) : 0;
        const comment = v.str(c.body.comment, "ひとこと", { max: 100 });
        await c.db.run(
          `INSERT INTO live_rsvps(live_id, member_id, status, tickets, comment, updated_at) VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(live_id, member_id) DO UPDATE SET status = excluded.status, tickets = excluded.tickets,
             comment = excluded.comment, updated_at = excluded.updated_at`,
          row.id, memberId, status, tickets, comment, c.now.ts,
        );
        return { live: await liveView(c.db, row, c.member) };
      },
    ],
    [
      "DELETE",
      "/lives/:id/rsvp",
      async (c) => {
        const row = await getLive(c.db, c.params.id);
        await c.db.run("DELETE FROM live_rsvps WHERE live_id = ? AND member_id = ?", row.id, c.member.id);
        return { live: await liveView(c.db, row, c.member) };
      },
    ],
  ],
};
