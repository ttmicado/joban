// メンバー・チーム参加・チーム設定（コア機能）
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { v } from "../validate.js";

const POSITIONS = ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", "DH"];

// API で返すメンバー表現（LINE の userId は外に出さない）
export function publicMember(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    picture: m.picture || "",
    number: m.number || "",
    positions: m.positions ? m.positions.split(",").filter(Boolean) : [],
    throws: m.throws || "",
    bats: m.bats || "",
    role: m.role,
    isGuest: !!m.is_guest,
    active: !!m.active,
    linked: !!m.line_user_id,
  };
}

function profileFields(body, { requireName = false } = {}) {
  const out = {};
  if (body.name !== undefined || requireName) out.name = v.str(body.name, "名前", { max: 30, required: true });
  if (body.number !== undefined) out.number = v.str(body.number, "背番号", { max: 4 });
  if (body.positions !== undefined) {
    const list = Array.isArray(body.positions) ? body.positions : String(body.positions || "").split(",");
    if (list.length > 20) throw badRequest("守備位置の値が不正です");
    const clean = list.map((p) => String(p).trim()).filter(Boolean);
    for (const p of clean) if (!POSITIONS.includes(p)) throw badRequest("守備位置の値が不正です");
    out.positions = [...new Set(clean)].join(",");
  }
  if (body.throws !== undefined) out.throws = v.oneOf(body.throws, "投", ["右", "左"]);
  if (body.bats !== undefined) out.bats = v.oneOf(body.bats, "打", ["右", "左", "両"]);
  return out;
}

async function update(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.run(`UPDATE members SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
}

async function getMember(db, id) {
  const m = await db.one("SELECT * FROM members WHERE id = ?", Number(id));
  if (!m) throw notFound("メンバーが見つかりません");
  return m;
}

const publicSettings = (s) => ({
  teamName: s.teamName,
  season: s.season,
  inningsPerGame: s.inningsPerGame,
  homeVenue: s.homeVenue,
});

export default {
  name: "members",
  migrations: [],
  routes: [
    // ログイン中ユーザーの状態（未参加なら member: null）
    [
      "GET",
      "/me",
      async (c) => {
        const count = (await c.db.one("SELECT COUNT(*) AS n FROM members WHERE line_user_id IS NOT NULL")).n;
        // LINE のアイコン・表示名は最新に追従
        if (c.member && (c.member.picture !== c.user.pictureUrl || c.member.line_name !== c.user.displayName)) {
          await update(c.db, c.member.id, { picture: c.user.pictureUrl, line_name: c.user.displayName });
          c.member = await getMember(c.db, c.member.id);
        }
        return {
          user: { name: c.user.displayName, picture: c.user.pictureUrl },
          member: publicMember(c.member),
          settings: publicSettings(c.settings),
          firstMember: count === 0,
        };
      },
      { auth: "user" },
    ],

    // チームに参加（最初に参加した人が管理者になる）
    [
      "POST",
      "/join",
      async (c) => {
        const existing = await c.db.one("SELECT * FROM members WHERE line_user_id = ?", c.user.userId);
        if (existing?.active) throw conflict("すでに参加しています", "already_joined");
        if (existing && !existing.active) throw forbidden("このアカウントは無効化されています。管理者に連絡してください");
        const f = profileFields(c.body, { requireName: true });
        const isFirst = (await c.db.one("SELECT COUNT(*) AS n FROM members WHERE line_user_id IS NOT NULL")).n === 0;
        const { lastId } = await c.db.run(
          `INSERT INTO members(line_user_id, name, line_name, picture, number, positions, throws, bats, role, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.user.userId,
          f.name,
          c.user.displayName,
          c.user.pictureUrl,
          f.number ?? null,
          f.positions ?? "",
          f.throws ?? null,
          f.bats ?? null,
          isFirst ? "admin" : "member",
          c.now.ts,
        );
        const member = publicMember(await getMember(c.db, lastId));
        c.emit("member.joined", { member });
        return { member };
      },
      { auth: "user" },
    ],

    [
      "PATCH",
      "/me",
      async (c) => {
        await update(c.db, c.member.id, profileFields(c.body));
        return { member: publicMember(await getMember(c.db, c.member.id)) };
      },
    ],

    [
      "GET",
      "/members",
      async (c) => {
        const all = c.query.all === "1" && c.isAdmin;
        const rows = await c.db.all(
          `SELECT * FROM members ${all ? "" : "WHERE active = 1"}
           ORDER BY is_guest, CASE WHEN number ~ '^[0-9]+$' THEN CAST(number AS BIGINT) ELSE 9999 END, id`,
        );
        return { members: rows.map(publicMember) };
      },
    ],

    ["GET", "/members/:id", async (c) => ({ member: publicMember(await getMember(c.db, c.params.id)) })],

    // 助っ人（LINE 未連携メンバー）の追加
    [
      "POST",
      "/members",
      async (c) => {
        const f = profileFields(c.body, { requireName: true });
        const { lastId } = await c.db.run(
          `INSERT INTO members(name, number, positions, throws, bats, is_guest, created_at) VALUES(?, ?, ?, ?, ?, 1, ?)`,
          f.name,
          f.number ?? null,
          f.positions ?? "",
          f.throws ?? null,
          f.bats ?? null,
          c.now.ts,
        );
        return { member: publicMember(await getMember(c.db, lastId)) };
      },
      { auth: "admin" },
    ],

    [
      "PATCH",
      "/members/:id",
      async (c) => {
        const m = await getMember(c.db, c.params.id);
        c.requireAdminOrSelf(m.id);
        const f = profileFields(c.body);
        if (c.isAdmin) {
          if (c.body.role !== undefined) {
            f.role = v.oneOf(c.body.role, "権限", ["admin", "member"], { required: true });
            if (f.role === "admin" && !m.line_user_id) throw badRequest("LINE未連携のメンバーは管理者にできません");
          }
          if (c.body.active !== undefined) f.active = c.body.active ? 1 : 0;
          if (c.body.isGuest !== undefined) f.is_guest = c.body.isGuest ? 1 : 0;
          const demoting = (f.role === "member" || f.active === 0) && m.role === "admin";
          if (demoting) {
            const admins = (await c.db.one("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1")).n;
            if (admins <= 1) throw badRequest("管理者が1人もいなくなってしまいます");
          }
        }
        await update(c.db, m.id, f);
        return { member: publicMember(await getMember(c.db, m.id)) };
      },
    ],

    ["GET", "/settings", (c) => ({ settings: publicSettings(c.settings) })],

    [
      "PATCH",
      "/settings",
      async (c) => {
        const b = c.body;
        const patch = {};
        if (b.teamName !== undefined) patch.teamName = v.str(b.teamName, "チーム名", { max: 30, required: true });
        if (b.season !== undefined) patch.season = v.int(b.season, "年度", { min: 2000, max: 2100, required: true });
        if (b.inningsPerGame !== undefined) patch.inningsPerGame = v.int(b.inningsPerGame, "規定イニング", { min: 1, max: 12, required: true });
        if (b.homeVenue !== undefined) patch.homeVenue = v.str(b.homeVenue, "ホーム球場", { max: 60 }) ?? "";
        await c.saveSettings(patch);
        return { settings: publicSettings(c.settings) };
      },
      { auth: "admin" },
    ],

    // カレンダー購読用トークン（URL を知っていれば誰でも購読できるので、メンバーにだけ渡す）
    ["GET", "/settings/ics", (c) => ({ token: c.settings.icsToken }), { auth: "member" }],
  ],
};
