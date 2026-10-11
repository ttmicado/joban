// teams.one からの取り込み（importer 機能）
//   POST /import/teamsone { slug, dryRun? }（管理者）
//   teams.one の公開ページ（選手名鑑・試合一覧・各試合）を取得・解析し、members / games / batting / pitching に登録する。
//   import_map で teams.one 側の ID（試合ID・正規化した選手名）とアプリ側の ID を対応付けるので、何度実行しても重複しない。
//   dryRun のときは同じ処理を SAVEPOINT 内で行い、最後に取り消して結果だけ返す。
import { ApiError, badRequest } from "../errors.js";
import { buildImport, normName, parseGameList } from "../importer/teamsone.js";

const ORIGIN = "https://teams.one";
// ヘッダーは ASCII のみ（日本語を入れると fetch が例外になる）
const USER_AGENT = "Mozilla/5.0 (compatible; JobanTeamApp-Importer/1.0; team stats import from public teams.one pages)";
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const MAX_LIST_PAGES = 10;
const MAX_GAMES = 300;
const MAX_BYTES = 3_000_000;
// Vercel 関数の上限（300秒）より十分短く。超えたら残りは次回の実行に回す（冪等なので再実行すれば続きから埋まる）
const FETCH_BUDGET_MS = 180_000;
const MEMO_MARK = "teams.one から取り込み";
const POSITIONS = ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", "DH", "控え"];

export const sourceKey = (slug) => `teamsone:${slug}`;

export function parseSlug(input) {
  let s = String(input ?? "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?teams\.one\/teams\/([^/?#]+)/i);
  if (m) s = m[1];
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw badRequest("チームURLの形式が不正です（例: https://teams.one/teams/joban-bulldogs）");
  return s;
}

class DryRun extends Error {
  constructor(result) {
    super("dry run");
    this.result = result;
  }
}

// ---------------------------------------------------------------- 取得

function makeFetcher(slug, { deadline }) {
  const base = `${ORIGIN}/teams/${slug}`;
  let count = 0;
  async function page(path = "") {
    const url = `${base}${path}`;
    // https://teams.one/teams/<slug> 配下以外は取得しない
    if (!(url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`))) throw new Error("取得対象外のURLです");
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() > deadline) throw new Error("時間切れ");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        count++;
        const res = await globalThis.fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "ja" },
          redirect: "follow",
          signal: ctrl.signal,
        });
        if (res.url && !res.url.startsWith(base)) throw Object.assign(new Error("別のページに転送されました"), { fatal: true });
        if (res.status === 404) throw Object.assign(new Error("ページが見つかりません（404）"), { fatal: true, status: 404 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_BYTES) throw Object.assign(new Error("ページが大きすぎます"), { fatal: true });
        return text;
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error("タイムアウトしました") : err;
        if (err.fatal) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
  return { page, base, count: () => count };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export async function fetchTeam(slug, { now = () => Date.now(), budgetMs = FETCH_BUDGET_MS } = {}) {
  const deadline = now() + budgetMs;
  const f = makeFetcher(slug, { deadline });
  const warnings = [];
  const must = async (path, label) => {
    try {
      return await f.page(path);
    } catch (err) {
      if (err.status === 404) throw badRequest(`teams.one にチーム「${slug}」が見つかりません。URLを確認してください`);
      throw new ApiError(502, "fetch_failed", `teams.one の${label}を取得できませんでした（${err.message}）。時間をおいてもう一度お試しください`);
    }
  };
  const [player, top] = await Promise.all([
    must("/player", "選手名鑑"),
    f.page("").catch((err) => (warnings.push(`チームトップを取得できませんでした（${err.message}）`), null)),
  ]);
  const gameLists = [await must("/game", "試合一覧")];
  for (let p = 2; p <= MAX_LIST_PAGES; p++) {
    if (!parseGameList(gameLists[gameLists.length - 1]).hasNext) break;
    try {
      gameLists.push(await f.page(`/game?page=${p}`));
    } catch (err) {
      warnings.push(`試合一覧の${p}ページ目を取得できませんでした（${err.message}）`);
      break;
    }
    if (p === MAX_LIST_PAGES && parseGameList(gameLists[gameLists.length - 1]).hasNext) {
      warnings.push(`試合一覧は${MAX_LIST_PAGES}ページまで取り込みました`);
    }
  }
  const ids = [];
  for (const html of gameLists) for (const g of parseGameList(html).games) if (!ids.includes(g.sourceId)) ids.push(g.sourceId);
  if (ids.length > MAX_GAMES) {
    warnings.push(`試合が多すぎるため新しい順に${MAX_GAMES}試合だけ取り込みます`);
    ids.length = MAX_GAMES;
  }
  const games = {};
  let timedOut = 0;
  await pool(ids, CONCURRENCY, async (id) => {
    if (now() > deadline) {
      timedOut++;
      return;
    }
    try {
      games[id] = await f.page(`/game/${id}`);
    } catch {
      // buildImport が「取得できませんでした」の警告を出す
    }
  });
  if (timedOut) warnings.push(`時間がかかりすぎたため${timedOut}試合を取得できませんでした。もう一度実行すると続きを取り込みます`);
  return { player, top, gameLists, games, warnings, pages: f.count() };
}

// ---------------------------------------------------------------- 登録

async function insertRows(db, table, cols, rows) {
  if (!rows.length) return;
  const ph = `(${cols.map(() => "?").join(", ")})`;
  await db.run(`INSERT INTO ${table}(${cols.join(", ")}) VALUES ${rows.map(() => ph).join(", ")} RETURNING game_id`, ...rows.flat());
}

const isEmpty = (v) => v === null || v === undefined || v === "";

function resultOf(our, their) {
  if (our === null || their === null || our === undefined || their === undefined) return null;
  return our > their ? "win" : our < their ? "lose" : "draw";
}

function memoOf(g, slug) {
  const lines = [`${MEMO_MARK}（${ORIGIN}/teams/${slug}/game/${g.sourceId}）`];
  if (g.title) lines.push(`大会: ${g.title}`);
  if (g.startTime) lines.push(`開始: ${g.startTime}`);
  const expect = resultOf(g.ourScore, g.theirScore);
  const label = { win: "勝ち", lose: "負け", draw: "引分け" }[expect];
  if (label && g.resultLabel && !g.resultLabel.startsWith(label.slice(0, 2))) {
    lines.push(`※ teams.one 上の勝敗は「${g.resultLabel}」（スコアは ${g.ourScore}-${g.theirScore}）`);
  }
  return lines.join("\n");
}

// 大会名があれば tournament。ただし「オープン戦」は練習試合の区分なのでそのまま
function kindOf(g) {
  if (g.title && !/^オープン戦$/.test(g.title)) return "tournament";
  return g.kind;
}

export async function applyImport(c, slug, data) {
  const db = c.db;
  const now = c.now.ts;
  const source = sourceKey(slug);
  const warnings = [...data.warnings];

  const mapRows = await db.all("SELECT kind, source_id, local_id FROM import_map WHERE source = ?", source);
  const map = { member: new Map(), game: new Map() };
  for (const r of mapRows) map[r.kind]?.set(r.source_id, r.local_id);
  const newMaps = [];

  // ---- 選手
  // 役職（members.title）は members 機能のマイグレーション（members-001）で追加される列。あるときだけ使う
  const hasTitle = !!(await db.one(
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'members' AND column_name = 'title'",
  ));
  const members = await db.all("SELECT * FROM members ORDER BY id");
  const byId = new Map(members.map((m) => [m.id, m]));
  // 同名が複数いれば、在籍中 → LINE 連携済み → 古い順を優先
  const byName = new Map();
  for (const m of [...members].sort((a, b) => b.active - a.active || !!b.line_user_id - !!a.line_user_id || a.id - b.id)) {
    const k = normName(m.name);
    if (k && !byName.has(k)) byName.set(k, m);
  }

  const stats = { created: 0, linked: 0, updated: 0, unchanged: 0, departed: 0 };
  const playerList = [];
  const memberIdOf = new Map(); // normName → members.id

  async function upsertPlayer(p, { active }) {
    const key = normName(p.name);
    let m = null;
    const mapped = map.member.get(key);
    if (mapped && byId.has(mapped)) m = byId.get(mapped);
    let action;
    if (!m) {
      m = byName.get(key) || null;
      if (m) action = "link";
    }
    if (m) {
      // 空欄の項目だけ埋める
      const patch = {};
      if (isEmpty(m.number) && p.number) patch.number = String(p.number).slice(0, 4);
      if (isEmpty(m.throws) && p.throws) patch.throws = p.throws;
      if (isEmpty(m.bats) && p.bats) patch.bats = p.bats;
      if (isEmpty(m.positions) && p.positions?.length) patch.positions = p.positions.join(",");
      if (hasTitle && isEmpty(m.title) && p.title) patch.title = String(p.title).slice(0, 60);
      const keys = Object.keys(patch);
      if (keys.length) {
        await db.run(`UPDATE members SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k]), m.id);
        Object.assign(m, patch);
        action ??= "update";
      }
      action ??= "same";
      if (action === "link") stats.linked++;
      else if (action === "update") stats.updated++;
      else stats.unchanged++;
    } else {
      const { lastId } = await db.run(
        `INSERT INTO members(name, number, positions, throws, bats, role, is_guest, active, created_at)
         VALUES(?, ?, ?, ?, ?, 'member', 0, ?, ?)`,
        p.name.slice(0, 30),
        p.number ? String(p.number).slice(0, 4) : null,
        (p.positions || []).join(","),
        p.throws || null,
        p.bats || null,
        active ? 1 : 0,
        now,
      );
      if (hasTitle && p.title) await db.run("UPDATE members SET title = ? WHERE id = ?", String(p.title).slice(0, 60), lastId);
      m = await db.one("SELECT * FROM members WHERE id = ?", lastId);
      byId.set(m.id, m);
      byName.set(key, m);
      action = "create";
      stats.created++;
      if (!active) stats.departed++;
    }
    if (map.member.get(key) !== m.id) {
      map.member.set(key, m.id);
      newMaps.push(["member", key, m.id]);
    }
    memberIdOf.set(key, m.id);
    playerList.push({
      id: m.id,
      name: m.name,
      sourceName: p.name,
      number: m.number || p.number || "",
      positions: p.positions || [],
      throws: p.throws || "",
      bats: p.bats || "",
      title: (hasTitle ? m.title : null) || p.title || "",
      category: p.category || "",
      inRoster: active,
      active: !!m.active,
      linked: !!m.line_user_id,
      action,
    });
    return m.id;
  }

  for (const p of data.players) await upsertPlayer(p, { active: true });

  // 名鑑に無いが試合に出ている人（退団者など）→ active 0。背番号は最新の試合のもの
  const extras = new Map();
  for (const g of [...data.games].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    for (const r of [...g.batting, ...g.pitching]) {
      const key = normName(r.name);
      if (!key || memberIdOf.has(key) || extras.has(key)) continue;
      extras.set(key, { name: r.name, number: r.number, positions: [], throws: null, bats: null });
    }
  }
  for (const p of extras.values()) await upsertPlayer(p, { active: false });

  // ---- 試合
  const gstats = { created: 0, updated: 0, skipped: 0 };
  const gameList = [];
  const innings = Number(c.settings.inningsPerGame) || 7;
  for (const g of data.games) {
    const label = `${g.date || "日付不明"} ${g.opponent || ""}`;
    if (!g.date || !/^\d{4}-\d{2}-\d{2}$/.test(g.date)) {
      warnings.push(`試合 ${g.sourceId}: 日付が読み取れないためスキップしました`);
      gstats.skipped++;
      continue;
    }
    if (g.ourScore === null || g.theirScore === null) {
      warnings.push(`${label}: スコアが読み取れないためスキップしました`);
      gstats.skipped++;
      continue;
    }
    const fields = {
      season: Number(g.date.slice(0, 4)),
      date: g.date,
      opponent: String(g.opponent || "不明").slice(0, 40),
      venue: g.venue ? g.venue.slice(0, 60) : null,
      kind: kindOf(g),
      innings,
      bat_first: g.batFirst ? 1 : 0,
      our_score: g.ourScore,
      their_score: g.theirScore,
      line_us: g.lineUs?.length ? JSON.stringify(g.lineUs) : null,
      line_them: g.lineThem?.length ? JSON.stringify(g.lineThem) : null,
      status: "final",
    };
    const memo = memoOf(g, slug);
    let gameId = map.game.get(String(g.sourceId));
    const existing = gameId ? await db.one("SELECT id, memo FROM games WHERE id = ?", gameId) : null;
    let action;
    if (existing) {
      // 管理者がメモを書き換えていたら残す
      const keepMemo = existing.memo && !existing.memo.includes(MEMO_MARK);
      const all = { ...fields, ...(keepMemo ? {} : { memo }), updated_at: now };
      const keys = Object.keys(all);
      await db.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => all[k]), gameId);
      action = "update";
      gstats.updated++;
    } else {
      const all = { ...fields, memo, event_id: null, created_at: now, updated_at: now };
      const keys = Object.keys(all);
      const { lastId } = await db.run(
        `INSERT INTO games(${keys.join(", ")}) VALUES(${keys.map(() => "?").join(", ")})`,
        ...keys.map((k) => all[k]),
      );
      gameId = lastId;
      map.game.set(String(g.sourceId), gameId);
      newMaps.push(["game", String(g.sourceId), gameId]);
      action = "create";
      gstats.created++;
    }

    // 打撃・投手成績は置き換え（teams.one に表が無ければ既存の成績は触らない）
    const rowsFor = (list, kind) => {
      const seen = new Set();
      const out = [];
      for (const r of list) {
        const mid = memberIdOf.get(normName(r.name));
        if (!mid) continue;
        if (seen.has(mid)) {
          warnings.push(`${label}: ${r.name} の${kind}が2行あるため2行目を無視しました`);
          continue;
        }
        seen.add(mid);
        out.push({ ...r, member_id: mid });
      }
      return out;
    };
    const bat = rowsFor(g.batting, "打撃成績");
    const pit = rowsFor(g.pitching, "投手成績");
    if (g.hasBatting) {
      await db.run("DELETE FROM batting WHERE game_id = ?", gameId);
      await db.run("DELETE FROM games_at_bats WHERE game_id = ?", gameId);
      await insertRows(
        db,
        "batting",
        ["game_id", "member_id", "order_no", "position", "pa", "ab", "h", "d2", "d3", "hr", "rbi", "r", "so", "bb", "hbp", "sh", "sf", "sb", "e", "updated_by", "updated_at"],
        bat.map((b) => [
          gameId, b.member_id, b.order_no ?? null, POSITIONS.includes(b.position) ? b.position : null,
          b.pa, b.ab, b.h, b.d2, b.d3, b.hr, b.rbi, b.r, b.so, b.bb, b.hbp, b.sh, b.sf, b.sb, b.e, c.member?.id ?? null, now,
        ]),
      );
    }
    if (g.hasPitching) {
      await db.run("DELETE FROM pitching WHERE game_id = ?", gameId);
      // 勝・敗は1試合1人まで（重複していたら最初の投手だけ）
      const used = new Set();
      await insertRows(
        db,
        "pitching",
        ["game_id", "member_id", "order_no", "outs", "bf", "pitches", "h", "hr", "so", "bb", "hbp", "r", "er", "decision", "updated_by", "updated_at"],
        pit.map((p) => {
          let d = p.decision;
          if ((d === "W" || d === "L") && used.has(d)) {
            warnings.push(`${label}: 「${d === "W" ? "勝" : "敗"}」が複数の投手に付いているため ${p.name} の分を外しました`);
            d = null;
          }
          if (d) used.add(d);
          return [gameId, p.member_id, p.order_no, p.outs, p.bf || 0, p.pitches, p.h, p.hr, p.so, p.bb, p.hbp, p.r, p.er, d, c.member?.id ?? null, now];
        }),
      );
    }
    gameList.push({
      id: gameId,
      sourceId: String(g.sourceId),
      date: g.date,
      season: fields.season,
      opponent: fields.opponent,
      kind: fields.kind,
      title: g.title,
      batFirst: !!fields.bat_first,
      our: g.ourScore,
      their: g.theirScore,
      result: resultOf(g.ourScore, g.theirScore),
      sourceResult: g.resultLabel,
      walkOff: !!g.walkOff,
      batting: g.hasBatting ? bat.length : null,
      pitching: g.hasPitching ? pit.length : null,
      action,
    });
  }

  if (newMaps.length) {
    await insertRowsMap(db, source, newMaps);
  }

  // 年度別のまとめ
  const seasons = new Map();
  for (const g of gameList) {
    const s = seasons.get(g.season) || { season: g.season, games: 0, win: 0, lose: 0, draw: 0, runs: 0, allowed: 0 };
    s.games++;
    s[g.result]++;
    s.runs += g.our;
    s.allowed += g.their;
    seasons.set(g.season, s);
  }

  return {
    slug,
    url: `${ORIGIN}/teams/${slug}`,
    teamName: data.teamName,
    players: { total: playerList.length, roster: data.players.length, ...stats },
    games: { total: gameList.length, found: data.games.length, ...gstats },
    seasons: [...seasons.values()].sort((a, b) => b.season - a.season),
    teamStats: data.teamStats,
    playerList,
    gameList: gameList.sort((a, b) => (a.date === b.date ? Number(b.sourceId) - Number(a.sourceId) : a.date < b.date ? 1 : -1)),
    warnings,
  };
}

async function insertRowsMap(db, source, rows) {
  // 1文あたりの行数を抑えて複数行 INSERT
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.run(
      `INSERT INTO import_map(source, kind, source_id, local_id, updated_at) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
       ON CONFLICT(source, kind, source_id) DO UPDATE SET local_id = excluded.local_id, updated_at = excluded.updated_at RETURNING source`,
      ...chunk.flatMap(([kind, id, local]) => [source, kind, id, local, Date.now()]),
    );
  }
}

// ---------------------------------------------------------------- ハンドラー

async function importTeamsOne(c) {
  const slug = parseSlug(c.body.slug ?? c.body.url);
  const dryRun = c.body.dryRun === true || c.body.dryRun === 1 || c.body.dryRun === "1" || c.body.dryRun === "true";
  const started = Date.now();
  const fetched = await fetchTeam(slug);
  const data = buildImport(fetched);
  data.warnings.unshift(...fetched.warnings);
  if (!data.players.length && !data.games.length) {
    throw badRequest("teams.one のページから選手・試合を読み取れませんでした。URLを確認してください");
  }
  let result;
  try {
    result = await c.db.savepoint(async () => {
      const r = await applyImport(c, slug, data);
      if (dryRun) throw new DryRun(r);
      return r;
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
    result = err.result;
  }
  if (!dryRun) {
    await c.db.run(
      `INSERT INTO import_runs(source, at, by_member_id, summary) VALUES(?, ?, ?, ?)`,
      sourceKey(slug),
      c.now.ts,
      c.member?.id ?? null,
      JSON.stringify({ players: result.players, games: result.games, warnings: result.warnings.length }),
    );
  }
  return { dryRun, ...result, pages: fetched.pages, elapsedMs: Date.now() - started };
}

async function lastRun(c) {
  const row = await c.db.one("SELECT * FROM import_runs ORDER BY at DESC, id DESC LIMIT 1");
  return { last: row ? { source: row.source, at: row.at, summary: JSON.parse(row.summary || "{}") } : null };
}

export default {
  name: "importer",
  migrations: [
    {
      id: "importer-001",
      sql: `
-- 外部サービスの ID とアプリ側の ID の対応（取り込みを何度実行しても重複しないように）
--   source: "teamsone:<slug>"、kind: member（source_id = 空白を除いた選手名）/ game（source_id = teams.one の試合ID）
CREATE TABLE IF NOT EXISTS import_map (
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  local_id BIGINT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (source, kind, source_id)
);
-- 取り込みの実行履歴
CREATE TABLE IF NOT EXISTS import_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  at BIGINT NOT NULL,
  by_member_id BIGINT,
  summary TEXT
);`,
    },
  ],
  routes: [
    ["POST", "/import/teamsone", importTeamsOne, { auth: "admin" }],
    ["GET", "/import/last", lastRun, { auth: "admin" }],
  ],
};
