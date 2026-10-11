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
    title: m.title || "", // 役職（監督・キャプテンなど。アプリの管理者権限 role とは別）
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
  if (body.title !== undefined) out.title = v.str(body.title, "役職", { max: 30 });
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

// ---------------------------------------------------------------- 選手の紐付け・統合
// teams.one などから取り込んだ「LINE 未連携の選手」に、後から LINE アカウントを紐付けたり、
// すでに参加済みのメンバーへ統合したりするための処理。

// メンバー id を参照している列（members 以外の全テーブルから列名で探す）
const REF_COLUMN_SQL = `
  SELECT c.table_name AS t, c.column_name AS col
  FROM information_schema.columns c
  JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
  WHERE c.table_schema = current_schema() AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'members'
    AND c.data_type IN ('bigint', 'integer', 'smallint')
    AND (c.column_name IN ('member_id', 'author_id', 'created_by', 'updated_by') OR c.column_name LIKE '%\\_member\\_id')
  ORDER BY c.table_name, c.column_name`;

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const tableExists = async (db, name) => !!(await db.one("SELECT to_regclass(?::text) AS r", name))?.r;

// テーブルの一意制約（主キー含む）ごとの列名
async function uniqueKeys(db, table) {
  const rows = await db.all(
    `SELECT ix.indexrelid::text AS idx, a.attname AS col
     FROM pg_index ix JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
     WHERE ix.indrelid = to_regclass(?::text) AND ix.indisunique`,
    table,
  );
  const map = new Map();
  for (const r of rows) map.set(r.idx, [...(map.get(r.idx) || []), r.col]);
  return [...map.values()];
}

// メンバー fromId を intoId に統合する（参照をすべて付け替えて fromId を削除）。
// 一意制約がぶつかる行（同じ試合に両方の成績がある等）は intoId の行を残し、fromId の行を捨てる。
// 背番号・投打・守備位置は intoId が空欄なら fromId の値で埋める。useName で fromId の名前に変える。
// fromId だけが LINE 連携済みなら、LINE 連携（と管理者権限）を intoId に移す。両方連携済みは不可。
// 呼び出し側のトランザクション内で実行される（途中で失敗すればリクエスト全体がロールバック）。
export async function mergeMembers(db, fromId, intoId, { useName = false } = {}) {
  const from = await getMember(db, fromId);
  const into = await getMember(db, intoId);
  if (from.id === into.id) throw badRequest("同じメンバーには統合できません");
  if (from.line_user_id && into.line_user_id) throw badRequest("どちらもLINE連携済みのため統合できません。先に片方の連携を解除してください");

  const moved = {};
  // 打席ごとの結果は試合単位: intoId がその試合に打撃成績を持っていれば fromId の打席はまるごと捨てる
  if ((await tableExists(db, "games_at_bats")) && (await tableExists(db, "batting"))) {
    const { changes } = await db.run(
      `DELETE FROM games_at_bats WHERE member_id = ? AND (
         game_id IN (SELECT game_id FROM batting WHERE member_id = ?) OR
         game_id IN (SELECT game_id FROM games_at_bats WHERE member_id = ?))`,
      from.id,
      into.id,
      into.id,
    );
    if (changes) moved["games_at_bats(dropped)"] = changes;
  }

  const keysCache = new Map();
  for (const { t, col } of await db.all(REF_COLUMN_SQL)) {
    if (!keysCache.has(t)) keysCache.set(t, await uniqueKeys(db, t));
    const T = ident(t);
    const C = ident(col);
    let dropped = 0;
    for (const key of keysCache.get(t).filter((k) => k.includes(col))) {
      const others = key.filter((k) => k !== col);
      const cond = others.map((o) => `y.${ident(o)} = x.${ident(o)}`).join(" AND ");
      const { changes } = await db.run(
        `DELETE FROM ${T} x WHERE x.${C} = ? AND EXISTS (SELECT 1 FROM ${T} y WHERE y.${C} = ?${cond ? ` AND ${cond}` : ""})`,
        from.id,
        into.id,
      );
      dropped += changes;
    }
    const { changes } = await db.run(`UPDATE ${T} SET ${C} = ? WHERE ${C} = ?`, into.id, from.id);
    if (changes || dropped) moved[`${t}.${col}`] = dropped ? { moved: changes, dropped } : changes;
  }

  // プロフィールの補完（空欄だけ埋める）
  const f = {};
  if (!into.number && from.number) f.number = from.number;
  if (!into.throws && from.throws) f.throws = from.throws;
  if (!into.bats && from.bats) f.bats = from.bats;
  if (!into.positions && from.positions) f.positions = from.positions;
  if (!into.title && from.title) f.title = from.title;
  if (useName) f.name = from.name;
  if (from.active && !into.active) f.active = 1;
  // LINE 連携を移す（一意制約があるので fromId を消してから）
  await db.run("DELETE FROM members WHERE id = ?", from.id);
  if (from.line_user_id) {
    Object.assign(f, { line_user_id: from.line_user_id, line_name: from.line_name, picture: from.picture, is_guest: 0, active: from.active });
    if (from.role === "admin") f.role = "admin";
  }
  await update(db, into.id, f);
  return { member: await getMember(db, into.id), moved };
}

// 紐付け・統合の候補（LINE 未連携・助っ人以外）。成績のある試合数つき
async function candidates(db) {
  const hasGames = await tableExists(db, "games");
  const rows = await db.all(
    hasGames
      ? `WITH gm AS (SELECT member_id, game_id FROM batting UNION SELECT member_id, game_id FROM pitching)
         SELECT m.*, COUNT(g.id) AS games, MIN(g.date) AS first_date, MAX(g.date) AS last_date
         FROM members m LEFT JOIN gm ON gm.member_id = m.id LEFT JOIN games g ON g.id = gm.game_id
         WHERE m.line_user_id IS NULL AND m.is_guest = 0
         GROUP BY m.id
         ORDER BY m.active DESC, CASE WHEN m.number ~ '^[0-9]+$' THEN CAST(m.number AS BIGINT) ELSE 9999 END, m.id`
      : `SELECT m.*, 0 AS games, NULL AS first_date, NULL AS last_date FROM members m
         WHERE m.line_user_id IS NULL AND m.is_guest = 0 ORDER BY m.active DESC, m.id`,
  );
  return rows.map((r) => ({
    ...publicMember(r),
    retired: !r.active,
    games: r.games || 0,
    firstYear: r.first_date ? Number(r.first_date.slice(0, 4)) : null,
    lastYear: r.last_date ? Number(r.last_date.slice(0, 4)) : null,
  }));
}

async function claimable(db, id) {
  const m = await getMember(db, id);
  if (m.line_user_id) throw conflict("この選手はすでに別のLINEアカウントと連携しています", "already_linked");
  if (m.is_guest) throw badRequest("助っ人は選べません");
  return m;
}

const countLinked = async (db) => (await db.one("SELECT COUNT(*) AS n FROM members WHERE line_user_id IS NOT NULL")).n;

const publicSettings = (s) => ({
  teamName: s.teamName,
  season: s.season,
  inningsPerGame: s.inningsPerGame,
  homeVenue: s.homeVenue,
});

export default {
  name: "members",
  migrations: [
    // 役職（監督・キャプテン・会計など。表示用の自由入力。管理者権限 role とは別）
    { id: "members-001", sql: "ALTER TABLE members ADD COLUMN IF NOT EXISTS title TEXT" },
  ],
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

    // 紐付けできる選手の一覧（参加画面の「あなたはどの選手ですか？」・過去データとの統合で使う）
    ["GET", "/join/candidates", async (c) => ({ candidates: await candidates(c.db) }), { auth: "user" }],

    // チームに参加（最初に参加した人が管理者になる）
    //   claimMemberId を指定すると、LINE 未連携の既存選手（取り込んだ過去の選手など）に LINE を紐付けて参加する
    [
      "POST",
      "/join",
      async (c) => {
        const existing = await c.db.one("SELECT * FROM members WHERE line_user_id = ?", c.user.userId);
        if (existing?.active) throw conflict("すでに参加しています", "already_joined");
        if (existing && !existing.active) throw forbidden("このアカウントは無効化されています。管理者に連絡してください");
        const claimId = v.int(c.body.claimMemberId, "選手", { min: 1, max: 1e12 });
        const isFirst = (await countLinked(c.db)) === 0;
        let id;
        if (claimId) {
          const target = await claimable(c.db, claimId);
          // 名前などは入力されたものだけ上書き（空欄なら取り込んだ値のまま）
          const body = { ...c.body };
          for (const k of ["name", "number", "throws", "bats", "title"]) if (body[k] === "" || body[k] === null) delete body[k];
          if (Array.isArray(body.positions) && !body.positions.length) delete body.positions;
          const f = profileFields(body);
          await update(c.db, target.id, {
            ...f,
            line_user_id: c.user.userId,
            line_name: c.user.displayName,
            picture: c.user.pictureUrl,
            active: 1,
            role: isFirst ? "admin" : target.role,
          });
          id = target.id;
        } else {
          const f = profileFields(c.body, { requireName: true });
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
          id = lastId;
        }
        const member = publicMember(await getMember(c.db, id));
        c.emit("member.joined", { member });
        return { member, claimed: !!claimId };
      },
      { auth: "user" },
    ],

    // 参加済みの人が、LINE 未連携の選手（取り込んだ過去の自分など）を自分に統合する
    [
      "POST",
      "/me/merge",
      async (c) => {
        const id = v.int(c.body.memberId, "選手", { min: 1, max: 1e12, required: true });
        if (id === c.member.id) throw badRequest("自分自身とは統合できません");
        await claimable(c.db, id);
        const { member, moved } = await mergeMembers(c.db, id, c.member.id, { useName: !!c.body.useName });
        return { member: publicMember(member), moved };
      },
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
          // LINE 連携の解除（間違って他人の選手を選んだときの修正用）。未連携の選手に戻す
          if (c.body.unlinkLine === true) {
            if (!m.line_user_id) throw badRequest("このメンバーはLINEと連携していません");
            if (m.id === c.member.id) throw badRequest("自分自身のLINE連携は解除できません");
            Object.assign(f, { line_user_id: null, line_name: null, picture: null, role: "member" });
          }
          // 在籍中の管理者を外すときは、ほかに在籍中の管理者が残ること
          const demoting = (f.role === "member" || f.active === 0) && m.role === "admin" && m.active;
          if (demoting) {
            const admins = (await c.db.one("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1")).n;
            if (admins <= 1) throw badRequest("管理者が1人もいなくなってしまいます");
          }
        }
        await update(c.db, m.id, f);
        return { member: publicMember(await getMember(c.db, m.id)) };
      },
    ],

    // 管理者: メンバー :id を intoId に統合（誤って新規登録してしまった人の後片付けなど）
    [
      "POST",
      "/members/:id/merge",
      async (c) => {
        const from = await getMember(c.db, c.params.id);
        const intoId = v.int(c.body.intoId, "統合先", { min: 1, max: 1e12, required: true });
        const { member, moved } = await mergeMembers(c.db, from.id, intoId, { useName: !!c.body.useName });
        return { member: publicMember(member), moved };
      },
      { auth: "admin" },
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
