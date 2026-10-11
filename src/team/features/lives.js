// お笑いライブ（チームの芸人コンビ「アミダライン」など）の告知と、選手の参加意思
import { badRequest, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";
import { publicMember } from "./members.js";

const STATUSES = ["go", "maybe", "no"]; // 行く / 迷い中 / 行けない

// アミダライン（和氣・山口）は最初からライブ情報を登録・編集できる。ほかの人は管理者が個別に許可する
const PERFORMER_NAMES = ["和氣達朗", "山口陽常"];
const norm = (s) => String(s || "").replace(/[\s\u3000]/g, "");
export const canPostLives = (m) =>
  !!m && (m.role === "admin" || Number(m.live_poster) === 1 || PERFORMER_NAMES.includes(norm(m.name)));

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
    canEdit: canPostLives(me),
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
    {
      // ライブ情報を登録・編集できるメンバー（芸人本人など）。管理者は常に可
      id: "lives-002",
      sql: `ALTER TABLE members ADD COLUMN IF NOT EXISTS live_poster BIGINT NOT NULL DEFAULT 0;`,
    },
    {
      // 2026年10月の公開済みスケジュール（アミダライン「10月のアミダ」より）
      id: "lives-003",
      sql: `
INSERT INTO lives(title, performer, date, start_time, venue, venue_url, note, created_at, updated_at)
SELECT v.title, 'アミダライン', v.date, v.start_time, v.venue, v.venue_url, v.note, 0, 0
FROM (VALUES
  ('炙りカルビ', '2026-10-02', '20:00', '池袋ムーブメントスタジオ', 'https://www.google.com/maps/search/?api=1&query=%E6%B1%A0%E8%A2%8B%20%E3%83%A0%E3%83%BC%E3%83%96%E3%83%A1%E3%83%B3%E3%83%88%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%AA', NULL),
  ('アガり！ステージ2部', '2026-10-05', '19:30', '新宿Sparkle', 'https://www.google.com/maps/search/?api=1&query=%E6%96%B0%E5%AE%BF%20Sparkle', NULL),
  ('若手ネタバトルライブ エレクトロアルファ', '2026-10-07', '20:00', '銀座アートボックス', 'https://www.google.com/maps/search/?api=1&query=%E9%8A%80%E5%BA%A7%E3%82%A2%E3%83%BC%E3%83%88%E3%83%9C%E3%83%83%E3%82%AF%E3%82%B9', NULL),
  ('フェ肉ス', '2026-10-13', '14:30', '池袋あうるすぽっと', 'https://www.google.com/maps/search/?api=1&query=%E3%81%82%E3%81%86%E3%82%8B%E3%81%99%E3%81%BD%E3%81%A3%E3%81%A8%20%E8%B1%8A%E5%B3%B6%E5%8C%BA%E7%AB%8B%E8%88%9E%E5%8F%B0%E8%8A%B8%E8%A1%93%E4%BA%A4%E6%B5%81%E3%82%BB%E3%83%B3%E3%82%BF%E3%83%BC', '29期の同期ライブ'),
  ('M-1グランプリ二回戦', '2026-10-15', NULL, '浅草雷5656会館', 'https://www.google.com/maps/search/?api=1&query=%E6%B5%85%E8%8D%89%E9%9B%B75656%E4%BC%9A%E9%A4%A8', '開演時間は未定'),
  ('渋谷神保町ファーストステージ', '2026-10-19', '18:30', '新宿レフカダ', 'https://www.google.com/maps/search/?api=1&query=%E6%96%B0%E5%AE%BF%E3%83%AC%E3%83%95%E3%82%AB%E3%83%80', NULL),
  ('3時間ぶっ通し！超青田買いコントライブ！', '2026-10-24', '12:00', 'よしもと六本木シアター', 'https://www.google.com/maps/search/?api=1&query=%E3%82%88%E3%81%97%E3%82%82%E3%81%A8%E5%85%AD%E6%9C%AC%E6%9C%A8%E3%82%B7%E3%82%A2%E3%82%BF%E3%83%BC', NULL),
  ('ラヴ・ラヴィ・コントVol.2', '2026-11-01', '13:00', '中野Vスタジオ', 'https://www.google.com/maps/search/?api=1&query=%E4%B8%AD%E9%87%8E%20V%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%AA', NULL)
) AS v(title, date, start_time, venue, venue_url, note)
WHERE NOT EXISTS (SELECT 1 FROM lives l WHERE l.date = v.date AND l.title = v.title);
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
        return { lives, canPost: canPostLives(c.member) };
      },
    ],
    ["GET", "/lives/posters", async (c) => {
      const rows = await c.db.all("SELECT * FROM members WHERE active = 1 ORDER BY id");
      return { members: rows.map((m) => ({ ...publicMember(m), canPostLives: canPostLives(m), byName: PERFORMER_NAMES.includes(norm(m.name)) })) };
    }, { auth: "admin" }],
    ["GET", "/lives/:id", async (c) => ({ live: await liveView(c.db, await getLive(c.db, c.params.id), c.member) })],
    [
      "POST",
      "/lives",
      async (c) => {
        if (!canPostLives(c.member)) throw forbidden("ライブ情報を登録できるのはアミダラインと管理者です");
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
        if (!canPostLives(c.member)) throw forbidden("ライブ情報を編集できるのはアミダラインと管理者です");
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
        if (!canPostLives(c.member)) throw forbidden("ライブ情報を削除できるのはアミダラインと管理者です");
        await c.db.run("DELETE FROM live_rsvps WHERE live_id = ?", row.id);
        await c.db.run("DELETE FROM lives WHERE id = ?", row.id);
        return { ok: true };
      },
    ],
    // ライブ情報の登録権限を付け外し（管理者）
    [
      "PUT",
      "/lives/posters/:memberId",
      async (c) => {
        const id = v.int(c.params.memberId, "メンバー", { min: 1, max: 1e12, required: true });
        if (!(await c.db.one("SELECT id FROM members WHERE id = ?", id))) throw notFound("メンバーが見つかりません");
        await c.db.run("UPDATE members SET live_poster = ? WHERE id = ?", c.body.allowed ? 1 : 0, id);
        return { ok: true };
      },
      { auth: "admin" },
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
