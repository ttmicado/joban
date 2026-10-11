// teams.one（https://teams.one/teams/<slug>）の公開ページを解析する純粋なパーサー。
// 依存ライブラリなし。簡単な HTML トークナイザで軽量な木を作り、class 名などで要素を探す。
//
//   parsePlayers(html)     → { teamName, players: [{ sourceId, number, name, positions, throws, bats, role, category }] }
//   parseGameList(html)    → { teamName, games: [{ sourceId, date, opponent, score, result }], hasNext }
//   parseGame(html, id)    → { sourceId, date, kind, category, title, startTime, venue, opponent, batFirst, lineUs, lineThem,
//                              ourScore, theirScore, resultLabel, walkOff, batting: [...], pitching: [...], warnings: [...] }
//   parseTeamStats(html)   → [{ season, games, win, lose, draw, runs, allowed }]（チームトップの年度別成績）
//   normName(name)         → 空白（全角含む）を除いた比較用の名前

// ---------------------------------------------------------------- HTML → 木

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
// 閉じタグが省略されうる要素（同じ要素が始まったら前のものを閉じる）
const AUTO_CLOSE = { li: ["li"], p: ["p"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"], option: ["option"] };

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsaquo: "›", lsaquo: "‹", raquo: "»", laquo: "«",
  hellip: "…", middot: "·", copy: "©", reg: "®", times: "×", mdash: "—", ndash: "–", yen: "¥", ensp: " ", emsp: " ", thinsp: " ",
};

export function decodeEntities(s) {
  if (!s || !s.includes("&")) return s || "";
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

export function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const open = (tag, attrs) => {
    const auto = AUTO_CLOSE[tag];
    if (auto) {
      // 例: <li> の中で次の <li> が始まったら閉じる（ただし ul/ol/table などの境界は越えない）
      for (let n = cur; n && n !== root; n = n.parent) {
        if (auto.includes(n.tag)) {
          cur = n.parent;
          break;
        }
        if (["ul", "ol", "table", "tbody", "thead", "tfoot", "div", "select"].includes(n.tag)) break;
      }
    }
    const el = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    return el;
  };
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) cur.children.push({ text: src.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      // 対応する開きタグまで閉じる。見つからなければ無視
      for (let n = cur; n && n !== root; n = n.parent) {
        if (n.tag === tag) {
          cur = n.parent;
          break;
        }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrStr = m[3] || "";
      const el = open(tag, parseAttrs(attrStr));
      if (VOID.has(tag) || /\/\s*$/.test(attrStr)) continue;
      if (RAW_TEXT.has(tag)) {
        const end = src.toLowerCase().indexOf(`</${tag}`, last);
        const stop = end === -1 ? src.length : end;
        el.children.push({ text: src.slice(last, stop) });
        const close = src.indexOf(">", stop);
        last = re.lastIndex = close === -1 ? src.length : close + 1;
        continue;
      }
      cur = el;
    }
  }
  if (last < src.length) cur.children.push({ text: src.slice(last) });
  return root;
}

// ---------------------------------------------------------------- 木の検索

const classes = (n) => (n.attrs?.class || "").split(/\s+/).filter(Boolean);
const hasClass = (n, c) => !!n.tag && classes(n).includes(c);

function findAll(node, pred, out = []) {
  for (const ch of node.children || []) {
    if (!ch.tag) continue;
    if (pred(ch)) out.push(ch);
    findAll(ch, pred, out);
  }
  return out;
}
const find = (node, pred) => {
  for (const ch of node.children || []) {
    if (!ch.tag) continue;
    if (pred(ch)) return ch;
    const hit = find(ch, pred);
    if (hit) return hit;
  }
  return null;
};
const byClass = (node, c, tag) => node && find(node, (n) => hasClass(n, c) && (!tag || n.tag === tag));
const allByClass = (node, c, tag) => (node ? findAll(node, (n) => hasClass(n, c) && (!tag || n.tag === tag)) : []);
const byTag = (node, tag) => node && find(node, (n) => n.tag === tag);
const allByTag = (node, tag) => (node ? findAll(node, (n) => n.tag === tag) : []);

// テキスト（エンティティをデコードし、連続する空白は1つに。全角スペースは残す）
export function textOf(node) {
  if (!node) return "";
  let s = "";
  const walk = (n) => {
    if (n.text !== undefined) s += n.text;
    else if (n.tag === "br") s += " ";
    else if (n.tag !== "script" && n.tag !== "style") for (const ch of n.children) walk(ch);
  };
  walk(node);
  return decodeEntities(s).replace(/[ \t\r\n ]+/g, " ").trim();
}

// ---------------------------------------------------------------- 共通

// 名前の比較用: 空白（全角・半角）を除く
export const normName = (s) => String(s || "").replace(/[\s　 ]+/g, "");
// 表示用: 全角スペースはそのまま、前後の空白を除く
const cleanName = (s) => String(s || "").replace(/[ \t\r\n ]+/g, " ").trim();
// 全角数字 → 半角
const hankaku = (s) => String(s || "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

function teamNameOf(doc) {
  const dd = byClass(doc, "teamSelectDropdown");
  const name = dd && textOf(byTag(dd, "span") || dd);
  return name || null;
}

const toInt = (s) => {
  const t = hankaku(String(s ?? "")).trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
};

// "2026/7/12" → "2026-07-12"
function toDate(s) {
  const m = hankaku(s).match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function idFromHref(href, kind) {
  const m = String(href || "").match(new RegExp(`/${kind}/(\\d+)`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- 選手名鑑

const POSITION_CATEGORY = { 投手: "pitcher", 捕手: "catcher", 内野手: "infielder", 外野手: "outfielder", スタッフ: "staff" };
const HAND = { 右: "右", 左: "左", 両: "両" };

export function parsePlayers(src) {
  const doc = parseHtml(src);
  const players = [];
  const seen = new Set();
  const list = byClass(doc, "memberNameList") || doc;
  for (const li of findAll(list, (n) => n.tag === "li" && hasClass(n, "player-all"))) {
    const name = cleanName(textOf(byClass(li, "name")));
    if (!name || seen.has(normName(name))) continue;
    seen.add(normName(name));
    const numText = hankaku(textOf(byClass(li, "number")));
    const info = textOf(byClass(li, "playerMainInfo"))
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);
    let category = null;
    let throws = null;
    let bats = null;
    for (const part of info) {
      if (POSITION_CATEGORY[part]) category = part;
      else if (/^[右左両]{2}$/.test(part)) {
        throws = HAND[part[0]] === "両" ? null : HAND[part[0]];
        bats = HAND[part[1]];
      }
    }
    // 役職（「副キャプテン / 会計」など。重複は除く）
    const roleParts = textOf(byClass(li, "positoin") || byClass(li, "position"))
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);
    const role = [...new Set(roleParts)].join(" / ") || null;
    const a = byTag(li, "a");
    players.push({
      sourceId: idFromHref(a?.attrs.href, "player"),
      number: /^\d{1,4}$/.test(numText) ? numText : numText || null,
      name,
      category,
      positions: category === "投手" ? ["投"] : category === "捕手" ? ["捕"] : [],
      throws,
      bats,
      role,
      title: role, // 役職（members.title に入れる。アプリの管理者権限 members.role とは別物）
    });
  }
  return { teamName: teamNameOf(doc), players };
}

// ---------------------------------------------------------------- 試合一覧

export function parseGameList(src) {
  const doc = parseHtml(src);
  const games = [];
  const seen = new Set();
  for (const a of findAll(doc, (n) => n.tag === "a" && /\/teams\/[\w-]+\/game\/\d+/.test(n.attrs.href || ""))) {
    const sourceId = idFromHref(a.attrs.href, "game");
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const opp = byClass(a, "opponent");
    let opponent = null;
    if (opp) {
      const label = byClass(opp, "label");
      opponent = textOf(opp).replace(textOf(label), "").trim() || null;
    }
    games.push({
      sourceId,
      date: toDate(textOf(byClass(a, "date"))),
      opponent,
      score: textOf(byClass(a, "score")) || null,
      result: textOf(byClass(a, "result")) || null,
    });
  }
  const pager = byClass(doc, "pagination");
  const hasNext = !!(pager && find(pager, (n) => n.tag === "a" && /\bnext\b/.test(n.attrs.rel || "")));
  return { teamName: teamNameOf(doc), games, hasNext };
}

// ---------------------------------------------------------------- チーム成績（トップページ）

export function parseTeamStats(src) {
  const doc = parseHtml(src);
  const out = [];
  for (const table of allByTag(doc, "table")) {
    const rows = allByTag(table, "tr").map((tr) => allByTag(tr, "th").concat(allByTag(tr, "td")).map(textOf));
    const head = rows[0] || [];
    if (!(head[0] === "年" && head.includes("勝ち"))) continue;
    const idx = (k) => head.indexOf(k);
    for (const r of rows.slice(1)) {
      const season = toInt(r[0]);
      if (!season) continue;
      out.push({
        season,
        games: toInt(r[idx("試合")]),
        win: toInt(r[idx("勝ち")]),
        lose: toInt(r[idx("負け")]),
        draw: toInt(r[idx("引分")]),
        runs: toInt(r[idx("得点")]),
        allowed: toInt(r[idx("失点")]),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 試合詳細

// "5回0/3" → 15, "2回1/3" → 7, "1/3" → 1, "3" → 9
export function parseOuts(s) {
  const t = hankaku(String(s || "")).replace(/\s+/g, "");
  if (!t || t === "-") return 0;
  let m = t.match(/^(\d+)回(?:(\d)\/3)?$/);
  if (m) return Number(m[1]) * 3 + Number(m[2] || 0);
  m = t.match(/^(?:(\d+)\s*)?(\d)\/3$/);
  if (m) return Number(m[1] || 0) * 3 + Number(m[2]);
  m = t.match(/^(\d+)\.(\d)$/); // 5.1（=5回1/3）表記
  if (m) return Number(m[1]) * 3 + Math.min(2, Number(m[2]));
  m = t.match(/^(\d+)$/);
  if (m) return Number(m[1]) * 3;
  return 0;
}

// "4x" → { n: 4, x: true }
function parseScoreCell(s) {
  const t = hankaku(String(s || "")).replace(/\s+/g, "");
  const m = t.match(/^(\d+)\s*([xXｘＸ×])?$/);
  if (!m) return { n: null, x: /^[xXｘＸ×]$/.test(t) };
  return { n: Number(m[1]), x: !!m[2] };
}

const KIND_OF = { 公式戦: "league", 練習試合: "friendly" };
const DECISION_OF = { 勝: "W", 敗: "L", S: "S", H: "H", セーブ: "S", ホールド: "H" };

// 列見出し → キー
const BAT_COLS = {
  打順: "order_no", 守備: "position", 打席: "pa", 打数: "ab", 安打: "h", 本: "hr", 本塁打: "hr", 打点: "rbi", 得点: "r",
  盗塁: "sb", 二塁打: "d2", 三塁打: "d3", 三振: "so", 四球: "bb", 死球: "hbp", 犠打: "sh", 犠飛: "sf", 失策: "e",
};
const PIT_COLS = {
  勝敗: "decision", 投球回: "outs", 投球数: "pitches", 球数: "pitches", 失点: "r", 自責点: "er", 被安打: "h",
  被本塁打: "hr", 奪三振: "so", 与四球: "bb", 与死球: "hbp", 登板順: "order_no", 打者: "bf", 対戦打者: "bf",
};
const BAT_NUM = ["pa", "ab", "h", "d2", "d3", "hr", "rbi", "r", "so", "bb", "hbp", "sh", "sf", "sb", "e"];
const PIT_NUM = ["pitches", "h", "hr", "so", "bb", "hbp", "r", "er", "bf"];

function tableRows(table) {
  return allByTag(table, "tr").map((tr) => {
    const cells = findAll(tr, (n) => n.tag === "td" || n.tag === "th").filter((c) => !hasNestedCell(c));
    return cells.map((c) => ({ text: textOf(c), node: c }));
  });
}
const hasNestedCell = (c) => !!find(c, (n) => n.tag === "td" || n.tag === "th");

// 成績表（見出し行で列を対応付ける。見出しが途中に再度出ても読み飛ばす）
function parseStatTable(table, cols, warnings, label) {
  if (!table) return [];
  const out = [];
  let head = null;
  for (const row of tableRows(table)) {
    const texts = row.map((c) => c.text);
    if (texts.includes("選手名")) {
      head = texts;
      continue;
    }
    if (!head || texts.length < 2) continue;
    const at = (k) => head.indexOf(k);
    const nameIdx = at("選手名");
    const name = cleanName(texts[nameIdx]);
    if (!name || name === "-" || name === "合計" || name === "計") continue;
    const link = find(row[nameIdx].node, (n) => n.tag === "a");
    const numIdx = at("#");
    const rec = {
      number: numIdx >= 0 && texts[numIdx] && texts[numIdx] !== "-" ? hankaku(texts[numIdx]) : null,
      name,
      playerSourceId: idFromHref(link?.attrs.href, "player"),
    };
    for (const [h, key] of Object.entries(cols)) {
      const i = at(h);
      if (i < 0 || key in rec) continue;
      rec[key] = texts[i] === undefined || texts[i] === "-" ? "" : texts[i];
    }
    out.push(rec);
  }
  if (!head && table) warnings.push(`${label}の見出し行が見つかりません`);
  return out;
}

function battingRecord(r, i, warnings, ctx) {
  const b = { number: r.number, name: r.name, playerSourceId: r.playerSourceId };
  b.order_no = toInt(r.order_no);
  b.position = r.position ? String(r.position).trim() || null : null;
  for (const k of BAT_NUM) b[k] = Math.max(0, toInt(r[k]) ?? 0);
  // teams.one の「安打」は長打を含む総数（安打 + 長打 > 打数 になる行があるため、長打を含まない解釈は成り立たない）。
  // 長打の合計が安打を超える入力ミスは、打率が teams.one と同じになるよう安打を優先して長打（二塁打→三塁打の順）を減らす
  const xbh = b.d2 + b.d3 + b.hr;
  if (b.h < xbh) {
    const before = `二塁打${b.d2}・三塁打${b.d3}・本塁打${b.hr}`;
    b.hr = Math.min(b.hr, b.h);
    b.d3 = Math.min(b.d3, b.h - b.hr);
    b.d2 = Math.min(b.d2, b.h - b.hr - b.d3);
    warnings.push(`${ctx}: ${b.name} の長打（${before}）が安打(${b.h})より多いため、二塁打${b.d2}・三塁打${b.d3}・本塁打${b.hr} に補正しました`);
  }
  if (b.ab < b.h) {
    warnings.push(`${ctx}: ${b.name} の打数(${b.ab})が安打(${b.h})より少ないため補正しました`);
    b.ab = b.h;
  }
  const minPa = b.ab + b.bb + b.hbp + b.sh + b.sf;
  if (b.pa < minPa) {
    if (b.pa > 0) warnings.push(`${ctx}: ${b.name} の打席(${b.pa})が打数・四死球・犠打飛の合計(${minPa})より少ないため補正しました`);
    b.pa = minPa;
  }
  if (b.so > b.ab) b.so = b.ab;
  return b;
}

function pitchingRecord(r, i, warnings, ctx) {
  const p = { number: r.number, name: r.name, playerSourceId: r.playerSourceId };
  p.order_no = toInt(r.order_no) ?? i + 1;
  p.outs = parseOuts(r.outs);
  for (const k of PIT_NUM) p[k] = Math.max(0, toInt(r[k]) ?? 0);
  p.decision = DECISION_OF[String(r.decision || "").trim()] || null;
  if (p.er > p.r) {
    warnings.push(`${ctx}: ${p.name} の自責点(${p.er})が失点(${p.r})より多いため補正しました`);
    p.er = p.r;
  }
  if (p.hr > p.h) p.h = p.hr;
  return p;
}

function parseScoreboard(table) {
  if (!table) return null;
  const rows = tableRows(table);
  const head = rows.find((r) => r.some((c) => c.text === "R")) || rows[0];
  if (!head) return null;
  const rIdx = head.findIndex((c) => c.text === "R" || hasClass(c.node, "score"));
  const lines = [];
  for (const row of rows) {
    if (row === head || !row.length) continue;
    const teamCell = row.find((c) => hasClass(c.node, "team")) || row[0];
    const scoreCell = row.find((c) => hasClass(c.node, "score")) || (rIdx >= 0 ? row[rIdx] : null);
    const innings = row.filter((c) => c !== teamCell && c !== scoreCell);
    let walkOff = false;
    const line = innings.map((c) => {
      const v = parseScoreCell(c.text);
      if (v.x) walkOff = true;
      return v.n;
    });
    while (line.length && line[line.length - 1] === null) line.pop();
    const total = scoreCell ? parseScoreCell(scoreCell.text) : { n: null, x: false };
    if (total.x) walkOff = true;
    lines.push({
      team: textOf(teamCell),
      line: line.length ? line : null,
      total: total.n,
      walkOff,
      isTop: hasClass(row[0].node.parent, "topInning"),
    });
  }
  if (lines.length < 2) return null;
  return { top: lines.find((l) => l.isTop) || lines[0], bottom: lines.find((l) => l !== (lines.find((x) => x.isTop) || lines[0])) };
}

// 省略表示（"常磐ブル…"）も考慮して同じチームか判定
function sameTeam(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const strip = (s) => s.replace(/[…\.]+$/, "");
  const xs = strip(x);
  const ys = strip(y);
  if (xs.length >= 2 && y.startsWith(xs)) return true;
  if (ys.length >= 2 && x.startsWith(ys)) return true;
  return false;
}

export function parseGame(src, sourceId = null, { teamName = null } = {}) {
  const doc = parseHtml(src);
  const warnings = [];
  const ours = teamName || teamNameOf(doc);
  const ov = byClass(doc, "gameOverview") || doc;
  const ctxDate = () => g.date || "日付不明";

  const g = {
    sourceId: sourceId ? String(sourceId) : null,
    date: null,
    kind: "friendly",
    category: null,
    title: null,
    startTime: null,
    venue: null,
    opponent: null,
    batFirst: 1,
    lineUs: null,
    lineThem: null,
    ourScore: null,
    theirScore: null,
    resultLabel: null,
    walkOff: false,
    hasBatting: false,
    hasPitching: false,
    batting: [],
    pitching: [],
    warnings,
  };

  if (!g.sourceId) {
    const og = find(doc, (n) => n.tag === "meta" && n.attrs.property === "og:url");
    g.sourceId = idFromHref(og?.attrs.content, "game");
  }

  // 種別・日付・時刻・大会名
  g.category = textOf(byClass(ov, "category")) || null;
  const dateEl = byClass(ov, "date");
  g.date = toDate(textOf(dateEl));
  const time = hankaku(textOf(byClass(ov, "time"))).match(/(\d{1,2}):(\d{2})/);
  if (time) g.startTime = `${time[1].padStart(2, "0")}:${time[2]}`;
  g.title = textOf(byClass(ov, "tournament")) || null;
  g.venue = textOf(byClass(ov, "place")) || null;
  g.resultLabel = textOf(byClass(ov, "result")) || null;

  // 並びが揺れても拾えるよう、「一覧へ」以降のテキスト列からも補う
  const tokens = overviewTokens(doc);
  if (!g.category) g.category = tokens.find((t) => /^(公式戦|練習試合|その他)$/.test(t)) || null;
  if (!g.date) g.date = toDate(tokens.find((t) => toDate(t)) || "");
  if (!g.startTime) {
    const t = tokens.map((x) => hankaku(x).match(/^(\d{1,2}):(\d{2})〜?$/)).find(Boolean);
    if (t) g.startTime = `${t[1].padStart(2, "0")}:${t[2]}`;
  }
  if (!g.resultLabel) g.resultLabel = tokens.find((t) => /^(勝ち|負け|引分け?)$/.test(t)) || null;
  if (g.category && KIND_OF[g.category]) g.kind = KIND_OF[g.category];

  // 先攻・後攻（概要の左が先攻）とスコア
  const teamEls = allByClass(byClass(ov, "gameInfo02") || ov, "team");
  const teamNames = teamEls.map((el) => cleanName(textOf(el)));
  const points = allByClass(byClass(ov, "score") || ov, "points").map((el) => parseScoreCell(textOf(el)));
  const board = parseScoreboard(byClass(doc, "scoreboard", "table"));
  if (board?.top.walkOff || board?.bottom.walkOff || points.some((p) => p.x)) g.walkOff = true;

  let topName = teamNames[0] || board?.top.team || null;
  let bottomName = teamNames[1] || board?.bottom.team || null;
  let weAreTop = null;
  if (ours && sameTeam(topName, ours)) weAreTop = true;
  else if (ours && sameTeam(bottomName, ours)) weAreTop = false;
  else if (ours && board && sameTeam(board.top.team, ours)) weAreTop = true;
  else if (ours && board && sameTeam(board.bottom.team, ours)) weAreTop = false;
  else {
    // 相手チームにはチームページへのリンクが付くことが多い
    const linked = teamEls.map((el) => !!(el.parent && el.parent.tag === "a"));
    if (linked[0] !== linked[1]) weAreTop = !linked[0];
  }
  if (weAreTop === null) {
    weAreTop = true;
    warnings.push(`${ctxDate()}: 自チームの先攻・後攻が判別できないため先攻として取り込みました`);
  }
  g.batFirst = weAreTop ? 1 : 0;
  g.opponent = (weAreTop ? bottomName : topName) || "不明";
  if (board && /…$/.test(g.opponent) && !teamNames.length) warnings.push(`${ctxDate()}: 相手チーム名が省略されています（${g.opponent}）`);

  const topScore = points[0]?.n ?? board?.top.total ?? (board?.top.line ? sum(board.top.line) : null);
  const bottomScore = points[1]?.n ?? board?.bottom.total ?? (board?.bottom.line ? sum(board.bottom.line) : null);
  g.ourScore = weAreTop ? topScore : bottomScore;
  g.theirScore = weAreTop ? bottomScore : topScore;
  if (board) {
    g.lineUs = (weAreTop ? board.top : board.bottom).line;
    g.lineThem = (weAreTop ? board.bottom : board.top).line;
    if (points.length >= 2 && board.top.total !== null && board.top.total !== points[0].n) {
      warnings.push(`${ctxDate()}: スコア表示（${points[0].n}）とスコアボード（${board.top.total}）の得点が違います`);
    }
    for (const [label, line, total] of [["自チーム", g.lineUs, g.ourScore], ["相手", g.lineThem, g.theirScore]]) {
      if (line && total !== null && sum(line) !== total) {
        warnings.push(`${ctxDate()}: ${label}のイニング得点の合計（${sum(line)}）と得点（${total}）が違います`);
      }
    }
  }
  if (g.ourScore === null || g.theirScore === null) warnings.push(`${ctxDate()}: スコアが読み取れませんでした`);
  // 勝敗表示とスコアの食い違い（例: 0-0 の「負け」）
  const expect = g.ourScore === null || g.theirScore === null ? null : g.ourScore > g.theirScore ? "勝ち" : g.ourScore < g.theirScore ? "負け" : "引分け";
  if (expect && g.resultLabel && !g.resultLabel.startsWith(expect.slice(0, 2))) {
    warnings.push(`${ctxDate()} ${g.opponent}: teams.one の勝敗「${g.resultLabel}」とスコア ${g.ourScore}-${g.theirScore} が一致しません（スコアを優先）`);
  }

  const ctx = `${ctxDate()} ${g.opponent}`;
  const batTable = byClass(doc, "stats_batting", "table");
  const pitTable = byClass(doc, "stats_pitching", "table");
  // 成績表が無い試合（テーブルが3個だけ等）はスコアだけ。has* が false なら既存の成績は触らない
  g.hasBatting = !!batTable;
  g.hasPitching = !!pitTable;
  g.batting = parseStatTable(batTable, BAT_COLS, warnings, "打撃成績").map((r, i) => battingRecord(r, i, warnings, ctx));
  g.pitching = parseStatTable(pitTable, PIT_COLS, warnings, "投手成績").map((r, i) => pitchingRecord(r, i, warnings, ctx));
  return g;
}

const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

// 「一覧へ」から試合概要の終わりまでのテキストを細かい単位で並べる
function overviewTokens(doc) {
  const out = [];
  let started = false;
  let done = false;
  const walk = (n) => {
    if (done) return;
    if (n.text !== undefined) {
      const t = decodeEntities(n.text).replace(/[ \t\r\n ]+/g, " ").trim();
      if (!t) return;
      if (!started) {
        if (t.includes("一覧へ")) started = true;
        return;
      }
      out.push(t);
      return;
    }
    if (started && (hasClass(n, "scoreboard") || hasClass(n, "battingPitchingContainer"))) {
      done = true;
      return;
    }
    if (n.tag === "script" || n.tag === "style") return;
    for (const ch of n.children) walk(ch);
  };
  walk(doc);
  return out;
}

// ---------------------------------------------------------------- まとめ

// 選手名鑑・試合一覧・試合詳細の HTML から取り込み用データを作る
//   pages: { player: html, gameLists: [html...], games: { [id]: html } }
export function buildImport({ player, gameLists = [], games = {}, top = null }) {
  const roster = player ? parsePlayers(player) : { teamName: null, players: [] };
  const list = [];
  const seen = new Set();
  let teamName = roster.teamName;
  for (const html of gameLists) {
    const p = parseGameList(html);
    teamName ||= p.teamName;
    for (const g of p.games) if (!seen.has(g.sourceId)) (seen.add(g.sourceId), list.push(g));
  }
  const parsed = [];
  const warnings = [];
  for (const item of list) {
    const html = games[item.sourceId];
    if (!html) {
      warnings.push(`試合 ${item.sourceId}（${item.date || ""} ${item.opponent || ""}）のページを取得できませんでした`);
      continue;
    }
    const g = parseGame(html, item.sourceId, { teamName });
    if (!g.date) g.date = item.date;
    if (!g.opponent || g.opponent === "不明") g.opponent = item.opponent || g.opponent;
    warnings.push(...g.warnings);
    parsed.push(g);
  }
  return {
    teamName,
    players: roster.players,
    games: parsed,
    teamStats: top ? parseTeamStats(top) : [],
    warnings,
  };
}
