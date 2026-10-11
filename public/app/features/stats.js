// 成績: ランキング・成績表・チーム成績・選手ページ
import { get, html, isAdmin, mount, navigate, on, post, raw, setHeader, state } from "../core.js";
import { avatar, busy, celebrate, empty, fmtDate, memberLabel, segmented, toast } from "../ui.js";
import { fmtIP, fmtNum, fmtRate, RESULT_LABEL } from "../lib/stats.js";

// ---------------------------------------------------------------- 表示ヘルパー
const fmt = (type, v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  if (type === "rate") return fmtRate(v);
  if (type === "dec2") return fmtNum(v, 2);
  return String(Math.round(v));
};

const CAT_ICON = { avg: "🎯", hr: "💥", rbi: "🔥", h: "⚾", sb: "👟", obp: "👀", ops: "⚡", era: "🛡️", w: "🏆", so: "🌀", sv: "🔒", whip: "🧊" };
const CAT_EMPTY = {
  avg: "規定打席に到達した選手はまだいません",
  hr: "第1号ホームランを打つのは誰だ！？",
  rbi: "最初の打点をあげるのは誰だ！？",
  h: "最初のヒットを打つのは誰だ！？",
  sb: "最初に走るのは誰だ！？",
  obp: "規定打席に到達した選手はまだいません",
  ops: "規定打席に到達した選手はまだいません",
  era: "規定投球回に到達した投手はまだいません",
  w: "初勝利をつかむのは誰だ！？",
  so: "最初の三振を奪うのは誰だ！？",
  sv: "試合を締めくくる守護神は誰だ！？",
  whip: "規定投球回に到達した投手はまだいません",
};
// 守備位置の色（野球カードの縁取り）
const POS_COLOR = { 投: "#ff5a5f", 捕: "#4da3ff", 一: "#27d17f", 二: "#27d17f", 三: "#27d17f", 遊: "#27d17f", 左: "#ffc83d", 中: "#ffc83d", 右: "#ffc83d", DH: "#a78bfa" };
const posColor = (m) => POS_COLOR[m?.positions?.[0]] || "#4da3ff";
const POS_NAME = { 投: "投手", 捕: "捕手", 一: "一塁手", 二: "二塁手", 三: "三塁手", 遊: "遊撃手", 左: "左翼手", 中: "中堅手", 右: "右翼手", DH: "指名打者" };

const seasonText = (s) => (s === "career" ? "通算" : `${s}年`);

// 数字のカウントアップ: <span data-count="0.333" data-fmt="rate">
function countUp(root) {
  const els = [...root.querySelectorAll("[data-count]")];
  if (!els.length) return;
  const final = () => els.forEach((el) => (el.textContent = fmt(el.dataset.fmt, Number(el.dataset.count))));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return final();
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    for (const el of els) {
      if (!el.isConnected) continue;
      el.textContent = fmt(el.dataset.fmt, Number(el.dataset.count) * e);
    }
    if (t < 1) requestAnimationFrame(step);
    else final();
  };
  requestAnimationFrame(step);
}
const counted = (type, v) =>
  v === null || v === undefined ? html`<span>-</span>` : html`<span data-count="${v}" data-fmt="${type}">${fmt(type, 0)}</span>`;

// 同じ演出を何度も出さない（セッション内で1回）
function celebrateOnce(key) {
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {}
  celebrate();
}

function seasonChips(seasons, current, hrefFor) {
  const list = [...seasons.map((s) => [String(s), `${s}`]), ["career", "通算"]];
  return html`<div class="st-seasons" role="tablist" aria-label="シーズン">
    ${list.map(([v, label]) => html`<a class="st-season ${String(current) === v ? "active" : ""}" href="#${hrefFor(v)}" role="tab">${label}</a>`)}
  </div>`;
}

const isMe = (m) => m && state.member && m.id === state.member.id;

function devSeedButton() {
  if (!state.mock || !isAdmin()) return "";
  return html`<button class="btn btn-sm btn-ghost" data-act="dev-seed">🧪 デモ用の成績を入れる（開発用）</button>`;
}
function bindDevSeed(root) {
  return on(root, "click", "[data-act=dev-seed]", (_, btn) =>
    busy(btn, async () => {
      const r = await post("/stats/dev-seed", {});
      toast(`デモ用に${r.games}試合を入れました`, { type: "success" });
      navigate(location.hash.slice(1), { replace: true });
    }),
  );
}

// ---------------------------------------------------------------- 表彰台
function podium(cat, { compact = false } = {}) {
  const top = cat.leaders.filter((x) => x.rank <= 3).slice(0, 3);
  if (!top.length) return html`<p class="st-cat-empty">${CAT_EMPTY[cat.key] || "まだ記録がありません"}</p>`;
  // 2位・1位・3位の並び（表彰台）
  const slots = [top[1], top[0], top[2]];
  const place = (x, i) => {
    if (!x) return html`<div class="st-pod st-pod-none"></div>`;
    const medal = x.rank === 1 ? "gold" : x.rank === 2 ? "silver" : "bronze";
    const big = i === 1;
    return html`<a class="st-pod st-pod-${medal} ${isMe(x.member) ? "is-me" : ""}" href="#/players/${x.member.id}">
      <span class="st-pod-avatar">${avatar(x.member, big && !compact ? "lg" : "md")}${x.rank === 1 ? html`<span class="st-crown">👑</span>` : ""}</span>
      <span class="st-pod-name ellipsis">${x.member.name}</span>
      <span class="st-pod-value num">${fmt(cat.type, x.value)}</span>
      <span class="st-pod-step"><span class="num">${x.rank}</span></span>
    </a>`;
  };
  return html`<div class="st-podium ${compact ? "compact" : ""}">${slots.map(place)}</div>`;
}

function catCard(cat, side, season) {
  // 表彰台に乗るのは先頭3人まで（3位タイが多いときは残りを下のリストへ）
  const rest = cat.leaders.slice(Math.min(3, cat.leaders.filter((x) => x.rank <= 3).length));
  const me = cat.me;
  let meLine = "";
  if (me && me.rank) {
    meLine = html`<p class="st-me ${me.rank === 1 ? "st-me-top" : ""}">${me.rank === 1 ? "👑 あなたがトップ！" : `あなたは ${me.rank}位`}
      <span class="num">${fmt(cat.type, me.value)}</span><span class="dim small">／${cat.total}人中</span></p>`;
  } else if (me && me.needed && me.needed.n > 0) {
    meLine = html`<p class="st-me st-me-wait">規定${side === "batting" ? "打席" : "投球回"}まで あと<b class="num">${me.needed.n}</b>${me.needed.unit}（いま ${fmt(cat.type, me.value)}）</p>`;
  } else if (me && cat.type === "count") {
    meLine = html`<p class="st-me st-me-wait">あなたはまだ 0。ここから巻き返そう！</p>`;
  }
  return html`<section class="card st-cat" data-cat="${cat.key}">
    <div class="card-head">
      <p class="card-title"><span class="icon">${CAT_ICON[cat.key] || "⚾"}</span>${cat.label}</p>
      ${cat.qualifiedOnly ? html`<span class="chip">規定${side === "batting" ? "打席" : "投球回"}以上</span>` : ""}
    </div>
    ${podium(cat)}
    ${rest.length
      ? html`<ol class="st-rest">
          ${rest.map(
            (x) => html`<li class="${isMe(x.member) ? "is-me" : ""}">
              <span class="st-rest-rank num">${x.rank}</span>
              <a href="#/players/${x.member.id}" class="grow ellipsis">${memberLabel(x.member)}</a>
              <span class="num st-rest-value">${fmt(cat.type, x.value)}</span>
            </li>`,
          )}
        </ol>`
      : ""}
    ${meLine}
  </section>`;
}

// ---------------------------------------------------------------- /stats
async function renderStats(view, { query }) {
  setHeader({ title: "成績" });
  const tab = ["batting", "pitching", "team"].includes(query.tab) ? query.tab : "batting";
  const { seasons, current } = await get("/stats/seasons");
  const season = query.season === "career" || /^\d{4}$/.test(query.season || "") ? query.season : String(current);
  const href = (t, s) => `/stats?tab=${t}&season=${s}`;

  const head = html`${segmented("stats-tab", [["batting", "⚾ 打撃"], ["pitching", "🔥 投手"], ["team", "🏟 チーム"]], tab)}
    ${seasonChips(seasons, season, (s) => href(tab, s))}`;

  let body;
  if (tab === "team") {
    const t = await get(`/stats/team?season=${season}`);
    body = teamView(t, season);
  } else {
    const data = await get(`/stats/leaders?season=${season}`);
    const cats = data[tab];
    const any = cats.some((c) => c.leaders.length);
    const q = data.qualify;
    body = html`<div class="st-qualify small muted" ${q.games ? "" : "hidden"}>
        ${seasonText(data.season)}・確定 <b class="num">${q.games}</b> 試合 ／ 規定${tab === "batting" ? html`打席 <b class="num">${q.pa}</b>` : html`投球回 <b class="num">${q.ip}</b>`}
      </div>
      ${any
        ? cats.map((c) => catCard(c, tab, season))
        : html`<div class="card">${empty(tab === "batting" ? "まだ記録がありません。最初のヒットを打つのは誰だ！？" : "まだ登板記録がありません。最初のマウンドに立つのは誰だ！？", {
            icon: tab === "batting" ? "🌟" : "🧢",
            action: devSeedButton(),
          })}</div>`}
      <a class="btn btn-block" href="#/stats/${tab}?season=${season}">📋 全員の${tab === "batting" ? "打撃" : "投手"}成績表を見る</a>`;
    const tops = cats.filter((c) => c.me?.rank === 1);
    if (tops.length) setTimeout(() => celebrateOnce(`stats-top-${tab}-${season}`), 350);
  }

  mount(view, html`${head}<div class="stack st-body">${body}</div>`);
  countUp(view);
  const offs = [
    on(view, "click", "[data-segmented=stats-tab] button", (_, b) => navigate(href(b.dataset.value, season), { replace: true })),
    bindDevSeed(view),
  ];
  return () => offs.forEach((f) => f());
}

function resultMark(r) {
  if (!r) return html`<span class="result result-draw">-</span>`;
  return html`<span class="result result-${r}">${RESULT_LABEL[r]}</span>`;
}

function teamView(t, season) {
  if (!t.games) {
    return html`<div class="card">${empty("まだ確定した試合がありません。記念すべき初戦はもうすぐ！", { icon: "🏟", action: devSeedButton() })}</div>`;
  }
  const streak = t.streak && t.streak.n >= 2
    ? html`<span class="chip ${t.streak.result === "win" ? "chip-green" : t.streak.result === "lose" ? "chip-red" : ""}">${t.streak.n}${t.streak.result === "win" ? "連勝中 🔥" : t.streak.result === "lose" ? "連敗中…" : "引き分け続き"}</span>`
    : "";
  const maxRuns = Math.max(t.runs, t.allowed, 1);
  return html`<section class="card card-hero st-team-hero">
      <p class="card-sub">${seasonText(t.season)}の戦績</p>
      <p class="st-record">
        <span class="num green">${counted("count", t.w)}</span><small>勝</small>
        <span class="num red">${counted("count", t.l)}</span><small>敗</small>
        <span class="num">${counted("count", t.d)}</span><small>分</small>
      </p>
      <div class="row gap wrap"><span class="chip chip-amber">勝率 ${fmtRate(t.winPct)}</span>${streak}</div>
    </section>
    <div class="tiles cols-4">
      ${[["チーム打率", "rate", t.avg], ["防御率", "dec2", t.era], ["本塁打", "count", t.hr], ["盗塁", "count", t.sb]].map(
        ([label, type, v]) => html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${counted(type, v)}</p></div>`,
      )}
    </div>
    <section class="card">
      <div class="card-head"><p class="card-title"><span class="icon">⚔️</span>得点と失点</p>
        <span class="chip ${t.runDiff >= 0 ? "chip-green" : "chip-red"}">得失点差 ${t.runDiff > 0 ? "+" : ""}${t.runDiff}</span></div>
      <div class="st-bars">
        <div class="st-bar"><span class="st-bar-label">得点</span><span class="st-bar-track"><i class="st-bar-fill st-bar-us" style="width:${Math.round((t.runs / maxRuns) * 100)}%"></i></span><span class="num st-bar-num">${counted("count", t.runs)}</span></div>
        <div class="st-bar"><span class="st-bar-label">失点</span><span class="st-bar-track"><i class="st-bar-fill st-bar-them" style="width:${Math.round((t.allowed / maxRuns) * 100)}%"></i></span><span class="num st-bar-num">${counted("count", t.allowed)}</span></div>
      </div>
      <p class="small muted st-bars-note">1試合平均 得点 ${fmtNum(t.runs / t.games, 1)} ／ 失点 ${fmtNum(t.allowed / t.games, 1)}</p>
    </section>
    <section class="card">
      <div class="card-head"><p class="card-title"><span class="icon">📈</span>勝敗の推移</p><span class="card-sub">${t.games}試合</span></div>
      <div class="st-marks">${t.results.map((r) => html`<a href="#/games/${r.id}" title="${fmtDate(r.date)} ${r.opponent}">${resultMark(r.result)}</a>`)}</div>
    </section>
    <p class="section-title">直近5試合</p>
    <div class="list">
      ${t.recent.map(
        (r) => html`<a class="list-item" href="#/games/${r.id}">
          ${resultMark(r.result)}
          <div class="list-main"><p class="list-title ellipsis">vs ${r.opponent}</p><p class="list-sub">${fmtDate(r.date, { year: season === "career" })}</p></div>
          <span class="num st-score">${r.our ?? "-"} - ${r.their ?? "-"}</span><span class="chev">›</span>
        </a>`,
      )}
    </div>`;
}

// ---------------------------------------------------------------- 成績表
const BAT_COLS = [
  ["avg", "打率", "rate", (p) => p.rates.avg],
  ["hr", "本塁打", "count", (p) => p.totals.hr],
  ["rbi", "打点", "count", (p) => p.totals.rbi],
  ["h", "安打", "count", (p) => p.totals.h],
  ["sb", "盗塁", "count", (p) => p.totals.sb],
  ["ops", "OPS", "rate", (p) => p.rates.ops],
  ["obp", "出塁率", "rate", (p) => p.rates.obp],
  ["slg", "長打率", "rate", (p) => p.rates.slg],
  ["games", "試合", "count", (p) => p.games],
  ["pa", "打席", "count", (p) => p.totals.pa],
  ["ab", "打数", "count", (p) => p.totals.ab],
  ["d2", "二塁打", "count", (p) => p.totals.d2],
  ["d3", "三塁打", "count", (p) => p.totals.d3],
  ["r", "得点", "count", (p) => p.totals.r],
  ["so", "三振", "count", (p) => p.totals.so],
  ["bb", "四死球", "count", (p) => p.totals.bb + p.totals.hbp],
];
const PIT_COLS = [
  ["era", "防御率", "dec2", (p) => p.rates.era, "asc"],
  ["w", "勝", "count", (p) => p.totals.w],
  ["l", "敗", "count", (p) => p.totals.l],
  ["sv", "S", "count", (p) => p.totals.sv],
  ["so", "奪三振", "count", (p) => p.totals.so],
  ["outs", "投球回", "ip", (p) => p.totals.outs],
  ["whip", "WHIP", "dec2", (p) => p.rates.whip, "asc"],
  ["games", "登板", "count", (p) => p.games],
  ["hld", "H", "count", (p) => p.totals.hld],
  ["h", "被安打", "count", (p) => p.totals.h],
  ["bb", "与四球", "count", (p) => p.totals.bb],
  ["r", "失点", "count", (p) => p.totals.r],
  ["er", "自責", "count", (p) => p.totals.er],
  ["k9", "奪三振率", "dec2", (p) => p.rates.k9],
];

async function renderTable(view, { query }, side) {
  const label = side === "batting" ? "打撃" : "投手";
  setHeader({ title: `${label}成績表`, back: `/stats?tab=${side}&season=${query.season || ""}` });
  const { seasons, current } = await get("/stats/seasons");
  const season = query.season === "career" || /^\d{4}$/.test(query.season || "") ? query.season : String(current);
  const data = await get(`/stats/${side}?season=${season}`);
  const cols = side === "batting" ? BAT_COLS : PIT_COLS;
  const prefKey = `stats-table-${side}`;
  let pref = {};
  try {
    pref = JSON.parse(localStorage.getItem(prefKey) || "{}");
  } catch {}
  let sortKey = cols.some((c) => c[0] === pref.sort) ? pref.sort : side === "batting" ? "avg" : "era";
  let dir = pref.dir === 1 || pref.dir === -1 ? pref.dir : null;
  let onlyQ = !!pref.onlyQ;
  const req = side === "batting" ? `規定打席 ${data.qualify.pa}（${data.qualify.games}試合×${data.qualify.paPerGame}）` : `規定投球回 ${data.qualify.ip}（${data.qualify.games}試合×${data.qualify.ipPerGame}）`;

  const draw = () => {
    const col = cols.find((c) => c[0] === sortKey);
    const d = dir ?? (col[4] === "asc" ? 1 : -1);
    const isRate = col[2] === "rate" || col[2] === "dec2";
    const rows = data.players
      .filter((p) => !onlyQ || p.qualified)
      .sort((a, b) => {
        if (isRate && a.qualified !== b.qualified) return a.qualified ? -1 : 1; // 率は規定到達者を上に
        const va = col[3](a);
        const vb = col[3](b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return (va - vb) * d || a.member.id - b.member.id;
      });
    const cell = (c, p) => (c[2] === "ip" ? fmtIP(c[3](p)) : fmt(c[2], c[3](p)));
    const body = view.querySelector("[data-table]");
    mount(
      body,
      rows.length
        ? html`<div class="table-wrap st-table-wrap"><table class="table st-table">
            <thead><tr>
              <th>選手</th>
              ${cols.map((c) => html`<th><button class="st-th ${c[0] === sortKey ? "active" : ""}" data-sort="${c[0]}">${c[1]}${c[0] === sortKey ? (d < 0 ? " ▼" : " ▲") : ""}</button></th>`)}
            </tr></thead>
            <tbody>
              ${rows.map(
                (p) => html`<tr class="${isMe(p.member) ? "is-me" : ""} ${p.qualified ? "" : "st-unq"}">
                  <td><a href="#/players/${p.member.id}" class="st-name">${memberLabel(p.member)}${p.qualified ? "" : html`<span class="st-unq-mark">＊</span>`}${p.member.isGuest ? html`<span class="st-guest">助</span>` : ""}</a></td>
                  ${cols.map((c) => html`<td class="${c[0] === sortKey ? "st-sorted" : ""}">${cell(c, p)}</td>`)}
                </tr>`,
              )}
            </tbody>
          </table></div>`
        : empty(onlyQ ? "規定に到達した選手はまだいません" : "まだ記録がありません。最初のヒットを打つのは誰だ！？", { icon: "📋" }),
    );
    mount(view.querySelector("[data-onlyq]"), html`${onlyQ ? "✅" : "⬜️"} 規定到達者のみ`);
    try {
      localStorage.setItem(prefKey, JSON.stringify({ sort: sortKey, dir, onlyQ }));
    } catch {}
  };

  mount(
    view,
    html`${seasonChips(seasons, season, (s) => `/stats/${side}?season=${s}`)}
      <div class="row gap st-table-tools">
        <button class="btn btn-sm" data-onlyq aria-pressed="${onlyQ}"></button>
        <span class="small muted grow st-req">${req}</span>
      </div>
      <div data-table></div>
      <p class="small dim">＊は規定未到達。列の見出しをタップで並べ替え。率は規定到達者を上に表示します。</p>`,
  );
  draw();
  const offs = [
    on(view, "click", "[data-sort]", (_, b) => {
      if (sortKey === b.dataset.sort) {
        const col = cols.find((c) => c[0] === sortKey);
        dir = -(dir ?? (col[4] === "asc" ? 1 : -1));
      } else {
        sortKey = b.dataset.sort;
        dir = null;
      }
      draw();
    }),
    on(view, "click", "[data-onlyq]", (_, b) => {
      onlyQ = !onlyQ;
      b.setAttribute("aria-pressed", String(onlyQ));
      draw();
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 選手ページ
function sparkline(points, log) {
  if (points.length < 2) return "";
  const W = 320;
  const H = 96;
  const px = 10;
  const py = 12;
  const vals = points.map((p) => p.avg);
  let lo = Math.max(0, Math.min(...vals) - 0.05);
  let hi = Math.min(1, Math.max(...vals) + 0.05);
  if (hi - lo < 0.1) [lo, hi] = [Math.max(0, lo - 0.05), Math.min(1, hi + 0.05)];
  const x = (i) => px + (i * (W - px * 2)) / (points.length - 1);
  const y = (v) => py + (1 - (v - lo) / (hi - lo)) * (H - py * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(" ");
  const area = `${d} L${x(points.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  const ref = 0.3 > lo && 0.3 < hi ? `<line x1="0" x2="${W}" y1="${y(0.3).toFixed(1)}" y2="${y(0.3).toFixed(1)}" class="st-spark-ref"/><text x="2" y="${(y(0.3) - 4).toFixed(1)}" class="st-spark-reftext">3割</text>` : "";
  const last = points[points.length - 1];
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="st-spark" role="img" aria-label="打率の推移（最新 ${fmtRate(last.avg)}）" preserveAspectRatio="none">
    <defs><linearGradient id="st-spark-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#27d17f" stop-opacity=".35"/><stop offset="1" stop-color="#27d17f" stop-opacity="0"/></linearGradient></defs>
    ${ref}
    <path d="${area}" fill="url(#st-spark-g)"/>
    <path d="${d}" class="st-spark-line"/>
    <line class="st-spark-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    <circle class="st-spark-dot" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="5"/>
  </svg>`;
  const coords = points.map((p, i) => {
    const g = log.find((x) => x.gameId === p.gameId);
    return { x: x(i) / W, y: y(p.avg) / H, text: `${fmtDate(p.date)} ${g ? `vs ${g.opponent}` : ""} ${p.ab}打数${p.h}安打 → ${fmtRate(p.avg)}` };
  });
  return { svg: raw(svg), coords, lastText: `最新 ${fmtRate(last.avg)}（${points.length}試合）` };
}

function bindSpark(root, spark) {
  const box = root.querySelector("[data-spark]");
  if (!box || !spark) return () => {};
  const svg = box.querySelector("svg");
  const tip = box.querySelector("[data-spark-tip]");
  const cross = svg.querySelector(".st-spark-cross");
  const dot = svg.querySelector(".st-spark-dot");
  const vb = svg.viewBox.baseVal;
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    let best = spark.coords[0];
    for (const c of spark.coords) if (Math.abs(c.x - fx) < Math.abs(best.x - fx)) best = c;
    cross.setAttribute("x1", best.x * vb.width);
    cross.setAttribute("x2", best.x * vb.width);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", best.x * vb.width);
    dot.setAttribute("cy", best.y * vb.height);
    tip.textContent = best.text;
  };
  const leave = () => {
    const last = spark.coords[spark.coords.length - 1];
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("cx", last.x * vb.width);
    dot.setAttribute("cy", last.y * vb.height);
    tip.textContent = spark.lastText;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave);
  return () => {
    svg.removeEventListener("pointermove", move);
    svg.removeEventListener("pointerdown", move);
    svg.removeEventListener("pointerleave", leave);
  };
}

function battingTiles(b) {
  return html`<div class="tiles cols-4">
    ${[["打率", "rate", b.rates.avg], ["本塁打", "count", b.totals.hr], ["打点", "count", b.totals.rbi], ["OPS", "rate", b.rates.ops]].map(
      ([label, type, v]) => html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${counted(type, v)}</p></div>`,
    )}
  </div>`;
}
function pitchingTiles(p) {
  return html`<div class="tiles cols-4">
    <div class="tile"><p class="tile-label">防御率</p><p class="tile-value">${counted("dec2", p.rates.era)}</p></div>
    <div class="tile"><p class="tile-label">勝利</p><p class="tile-value">${counted("count", p.totals.w)}</p></div>
    <div class="tile"><p class="tile-label">奪三振</p><p class="tile-value">${counted("count", p.totals.so)}</p></div>
    <div class="tile"><p class="tile-label">投球回</p><p class="tile-value st-ip">${fmtIP(p.totals.outs)}</p></div>
  </div>`;
}

function yearTables(byYear, career) {
  const bat = byYear.filter((y) => y.batting);
  const pit = byYear.filter((y) => y.pitching);
  return html`${bat.length
      ? html`<p class="section-title">年度別 打撃成績</p>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>年度</th><th>試合</th><th>打席</th><th>安打</th><th>本塁打</th><th>打点</th><th>盗塁</th><th>打率</th><th>OPS</th></tr></thead>
          <tbody>
            ${bat.map(({ season, batting: b }) => html`<tr><td>${season}</td><td>${b.games}</td><td>${b.totals.pa}</td><td>${b.totals.h}</td><td>${b.totals.hr}</td><td>${b.totals.rbi}</td><td>${b.totals.sb}</td><td>${fmtRate(b.rates.avg)}</td><td>${fmtRate(b.rates.ops)}</td></tr>`)}
            ${career.batting && bat.length > 1
              ? html`<tr class="total"><td>通算</td><td>${career.batting.games}</td><td>${career.batting.totals.pa}</td><td>${career.batting.totals.h}</td><td>${career.batting.totals.hr}</td><td>${career.batting.totals.rbi}</td><td>${career.batting.totals.sb}</td><td>${fmtRate(career.batting.rates.avg)}</td><td>${fmtRate(career.batting.rates.ops)}</td></tr>`
              : ""}
          </tbody>
        </table></div>`
      : ""}
    ${pit.length
      ? html`<p class="section-title">年度別 投手成績</p>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>年度</th><th>登板</th><th>勝</th><th>敗</th><th>S</th><th>投球回</th><th>奪三振</th><th>防御率</th><th>WHIP</th></tr></thead>
          <tbody>
            ${pit.map(({ season, pitching: p }) => html`<tr><td>${season}</td><td>${p.games}</td><td>${p.totals.w}</td><td>${p.totals.l}</td><td>${p.totals.sv}</td><td>${fmtIP(p.totals.outs)}</td><td>${p.totals.so}</td><td>${fmtNum(p.rates.era)}</td><td>${fmtNum(p.rates.whip)}</td></tr>`)}
            ${career.pitching && pit.length > 1
              ? html`<tr class="total"><td>通算</td><td>${career.pitching.games}</td><td>${career.pitching.totals.w}</td><td>${career.pitching.totals.l}</td><td>${career.pitching.totals.sv}</td><td>${fmtIP(career.pitching.totals.outs)}</td><td>${career.pitching.totals.so}</td><td>${fmtNum(career.pitching.rates.era)}</td><td>${fmtNum(career.pitching.rates.whip)}</td></tr>`
              : ""}
          </tbody>
        </table></div>`
      : ""}`;
}

function gameLogList(log) {
  return html`<div class="list st-log">
    ${log.map(
      (g) => html`<a class="list-item" href="#/games/${g.gameId}">
        ${resultMark(g.result)}
        <div class="list-main">
          <p class="list-title ellipsis">vs ${g.opponent} <span class="num st-log-score">${g.our ?? "-"}-${g.their ?? "-"}</span>${g.mvp ? html` <span class="chip chip-amber">MVP</span>` : ""}</p>
          <p class="list-sub">${fmtDate(g.date, { year: true })}</p>
          ${g.batting ? html`<p class="st-log-line ${g.batting.hr ? "hot" : ""}">🧢 ${g.batting.line}</p>` : ""}
          ${g.pitching ? html`<p class="st-log-line ${g.pitching.decision === "W" ? "hot" : ""}">⚾ ${g.pitching.line}</p>` : ""}
        </div>
        <span class="chev">›</span>
      </a>`,
    )}
  </div>`;
}

async function renderPlayer(view, { params }) {
  const id = Number(params.id);
  const me = state.member && state.member.id === id;
  setHeader({ title: me ? "マイページ" : "選手ページ", back: true, actions: me ? html`<a class="btn btn-sm" href="#/me/edit">✏️ 編集</a>` : "" });
  const p = await get(`/stats/players/${encodeURIComponent(params.id)}`);
  const m = p.member;
  if (!me) setHeader({ title: m.name, back: true });
  const cur = p.current;
  const hasAny = p.gameLog.length > 0;
  const spark = p.trend.points.length >= 2 ? sparkline(p.trend.points, p.gameLog) : null;
  const playerType = cur.pitching && (!cur.batting || p.isPitcher) ? "pitcher" : "batter";
  const handed = [m.throws && `${m.throws}投`, m.bats && `${m.bats}打`].filter(Boolean).join("");
  const top = p.ranks.filter((r) => r.rank === 1);

  mount(
    view,
    html`<section class="st-card" style="--pc:${posColor(m)}">
        <div class="st-card-shine"></div>
        <div class="st-card-top">
          <div class="st-card-num num">${m.number || "--"}</div>
          <div class="st-card-id">
            <p class="st-card-name">${m.name}</p>
            <p class="st-card-pos">
              ${m.positions.length ? m.positions.map((x) => html`<span class="st-pos" style="--pc:${POS_COLOR[x] || "#4da3ff"}">${POS_NAME[x] || x}</span>`) : html`<span class="st-pos">ポジション未登録</span>`}
            </p>
            <p class="st-card-meta">${handed || "投打未登録"}${m.isGuest ? " ・ 助っ人" : ""}${m.role === "admin" ? " ・ 管理者" : ""}</p>
          </div>
          <div class="st-card-avatar">${avatar(m, "xl")}</div>
        </div>
        ${p.titles.length || top.length
          ? html`<div class="st-badges">
              ${top.map((r) => html`<span class="st-badge st-badge-now">👑 今季${r.label}トップ</span>`)}
              ${p.titles.map((t) => html`<span class="st-badge">🏆 ${t.season} ${t.label}</span>`)}
            </div>`
          : ""}
        ${p.form ? html`<p class="st-form"><span class="st-form-icon">${p.form.icon}</span><b>${p.form.label}</b><span class="muted small">直近${p.form.games.length}試合 ${p.form.ab}打数${p.form.h}安打${p.form.hr ? ` ${p.form.hr}本塁打` : ""}</span>
            <span class="st-form-dots">${p.form.games.map((g) => html`<i class="${g.hr ? "hr" : g.h >= 2 ? "multi" : g.h ? "hit" : ""}" title="${g.h}安打"></i>`)}</span></p>` : ""}
      </section>

      ${!hasAny
        ? html`<div class="card">${empty(me ? "まだ記録がありません。最初のヒットを打つのはあなただ！" : "まだ記録がありません。最初のヒットを打つのは誰だ！？", { icon: "🌱" })}</div>`
        : html`
          <p class="section-title">${p.season}年 今季の成績 ${cur.batting && !cur.batting.qualified ? html`<span class="chip">規定打席未到達</span>` : ""}</p>
          ${!cur.batting && !cur.pitching ? html`<div class="card">${empty("今季はまだ出場がありません。次の試合で暴れよう！", { icon: "⏳" })}</div>` : ""}
          ${playerType === "pitcher" && cur.pitching ? pitchingTiles(cur.pitching) : ""}
          ${cur.batting ? battingTiles(cur.batting) : ""}
          ${playerType !== "pitcher" && cur.pitching ? pitchingTiles(cur.pitching) : ""}

          ${p.ranks.length
            ? html`<div class="st-ranks">
                ${p.ranks.map(
                  (r) => html`<span class="st-rank ${r.rank === 1 ? "gold" : r.rank === 2 ? "silver" : r.rank === 3 ? "bronze" : ""}">
                    <span class="st-rank-label">${r.label}</span><b class="num">${r.rank}</b><span class="st-rank-of">位/${r.of}</span>
                  </span>`,
                )}
              </div>`
            : ""}

          ${spark
            ? html`<section class="card st-spark-card" data-spark>
                <div class="card-head"><p class="card-title"><span class="icon">📈</span>打率の推移</p><span class="card-sub">${p.trend.scope === "season" ? "今季" : "通算"}・試合ごとの累積</span></div>
                ${spark.svg}
                <p class="st-spark-tip small muted" data-spark-tip>${spark.lastText}</p>
              </section>`
            : ""}

          <p class="section-title">試合ごとの成績 <span class="dim">${p.gameLog.length}試合</span></p>
          ${gameLogList(p.gameLog)}
          ${yearTables(p.byYear, p.career)}`}`,
  );
  countUp(view);
  if (me && top.length) setTimeout(() => celebrateOnce(`stats-player-top-${p.season}`), 400);
  const off = bindSpark(view, spark);
  return () => off();
}

// ---------------------------------------------------------------- ホームカード
async function myStatsCard() {
  if (!state.member) return "";
  const p = await get(`/stats/players/${state.member.id}`);
  const b = p.current.batting;
  const pi = p.current.pitching;
  if (!b && !pi) return "";
  const best = [...p.ranks].sort((a, b) => a.rank - b.rank)[0];
  const line = best
    ? best.rank === 1
      ? `👑 ${best.label}はチームトップ！この調子！`
      : best.rank <= 3
        ? `🔥 ${best.label}はチーム${best.rank}位。トップまであと少し！`
        : `📈 ${best.label}はチーム${best.rank}位。ここから巻き返そう！`
    : p.form
      ? `${p.form.icon} 直近の調子は「${p.form.label}」`
      : "";
  const tiles = [];
  if (b) tiles.push(["打率", "rate", b.rates.avg], ["本塁打", "count", b.totals.hr], ["打点", "count", b.totals.rbi]);
  if (pi) tiles.push(["防御率", "dec2", pi.rates.era]);
  return html`<a class="card card-link st-home-me" href="#/players/${state.member.id}">
    <div class="card-head"><p class="card-title"><span class="icon">📊</span>あなたの今季成績</p><span class="chev">›</span></div>
    <div class="tiles ${tiles.length === 4 ? "cols-4" : ""}">
      ${tiles.map(([label, type, v]) => html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${counted(type, v)}</p></div>`)}
    </div>
    ${line ? html`<p class="st-home-line">${line}</p>` : ""}
  </a>`;
}

const HOME_CATS = [["avg", "打率"], ["hr", "本塁打"], ["rbi", "打点"]];
async function leadersCard() {
  const data = await get("/stats/leaders");
  const cats = HOME_CATS.map(([k]) => data.batting.find((c) => c.key === k)).filter((c) => c && c.leaders.length);
  if (!cats.length) return "";
  const first = cats[0].key;
  return html`<section class="card st-home-leaders">
    <div class="card-head"><p class="card-title"><span class="icon">🏆</span>打撃ランキング</p><a class="small" href="#/stats?tab=batting">すべて見る ›</a></div>
    ${cats.length > 1 ? segmented("home-leaders", cats.map((c) => [c.key, c.label]), first) : ""}
    ${cats.map((c) => html`<div data-home-cat="${c.key}" ${c.key === first ? "" : "hidden"}>${podium(c, { compact: true })}</div>`)}
  </section>`;
}
function bindLeadersCard(el) {
  on(el, "click", "[data-segmented=home-leaders] button", (_, b) => {
    for (const x of el.querySelectorAll("[data-segmented=home-leaders] button")) {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-selected", String(x === b));
    }
    for (const x of el.querySelectorAll("[data-home-cat]")) x.hidden = x.dataset.homeCat !== b.dataset.value;
  });
}

export default {
  name: "stats",
  routes: {
    "/stats": renderStats,
    "/stats/batting": (view, ctx) => renderTable(view, ctx, "batting"),
    "/stats/pitching": (view, ctx) => renderTable(view, ctx, "pitching"),
    "/players/:id": renderPlayer,
  },
  homeCards: [
    { order: 40, render: myStatsCard, bind: (el) => countUp(el) },
    { order: 45, render: leadersCard, bind: bindLeadersCard },
  ],
  menu: [{ path: "/stats/batting", label: "個人成績表", icon: "📋", order: 30 }],
};
