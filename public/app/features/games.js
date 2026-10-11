// 試合結果・スコア・スタメン・打撃/投手成績の入力（games 機能）
import { $, appUrl, del, get, html, isAdmin, mount, navigate, on, patch, post, put, raw, setHeader, state } from "../core.js";
import {
  avatar,
  bindSteppers,
  busy,
  celebrate,
  chipTabs,
  confirmDialog,
  countUp,
  fab,
  empty,
  fmtDate,
  memberLabel,
  multiline,
  readForm,
  relDay,
  segmented,
  share,
  sheet,
  stepper,
  toast,
  toastError,
  todayStr,
} from "../ui.js";
import { RESULT_LABEL, battingRates, fmtIP, fmtRate, validateBatting } from "../lib/stats.js";
import { flexMessage, listBubble, resultBubble } from "../lib/flex.js";

// ---------------------------------------------------------------- 定数
const KIND = {
  league: ["公式戦", "chip-amber", "🏆"],
  tournament: ["大会", "chip-purple", "🎖"],
  friendly: ["練習試合", "chip-blue", "🤝"],
};
const POSITIONS = ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", "DH"];
const POS_NAME = { 投: "投手", 捕: "捕手", 一: "一塁", 二: "二塁", 三: "三塁", 遊: "遊撃", 左: "左翼", 中: "中堅", 右: "右翼", DH: "指名打者", 控え: "控え" };
const DECISION = { W: ["勝", "chip-green"], L: ["敗", "chip-red"], S: ["S", "chip-amber"], H: ["H", "chip-blue"] };

// 打席結果（サーバー src/team/features/games.js の AT_BAT と同じ）
const AT_BAT = {
  "1B": { label: "単打", short: "安", kind: "hit", add: { pa: 1, ab: 1, h: 1 } },
  "2B": { label: "二塁打", short: "二", kind: "hit", add: { pa: 1, ab: 1, h: 1, d2: 1 } },
  "3B": { label: "三塁打", short: "三", kind: "hit", add: { pa: 1, ab: 1, h: 1, d3: 1 } },
  HR: { label: "本塁打", short: "本", kind: "hr", add: { pa: 1, ab: 1, h: 1, hr: 1 } },
  BB: { label: "四球", short: "四", kind: "walk", add: { pa: 1, bb: 1 } },
  HBP: { label: "死球", short: "死", kind: "walk", add: { pa: 1, hbp: 1 } },
  E: { label: "失策出塁", short: "失", kind: "walk", add: { pa: 1, ab: 1 } },
  FC: { label: "野選", short: "野", kind: "walk", add: { pa: 1, ab: 1 } },
  SO: { label: "三振", short: "振", kind: "out", add: { pa: 1, ab: 1, so: 1 } },
  GO: { label: "ゴロ", short: "ゴ", kind: "out", add: { pa: 1, ab: 1 } },
  FO: { label: "フライ", short: "飛", kind: "out", add: { pa: 1, ab: 1 } },
  DP: { label: "併殺打", short: "併", kind: "out", add: { pa: 1, ab: 1 } },
  SH: { label: "犠打", short: "犠", kind: "sac", add: { pa: 1, sh: 1 } },
  SF: { label: "犠飛", short: "犠飛", kind: "sac", add: { pa: 1, sf: 1 } },
};
const AB_GROUPS = [
  ["ヒット", ["1B", "2B", "3B", "HR"]],
  ["出塁", ["BB", "HBP", "E", "FC"]],
  ["凡打・三振", ["SO", "GO", "FO", "DP"]],
  ["犠打", ["SH", "SF"]],
];
const COUNT_KEYS = ["pa", "ab", "h", "d2", "d3", "hr", "so", "bb", "hbp", "sh", "sf"];
const COUNT_LABEL = { pa: "打席", ab: "打数", h: "安打", d2: "二塁打", d3: "三塁打", hr: "本塁打", so: "三振", bb: "四球", hbp: "死球", sh: "犠打", sf: "犠飛" };
const EXTRA = [["rbi", "打点"], ["r", "得点"], ["sb", "盗塁"], ["e", "失策"]];
const PITCH = [["bf", "対戦打者"], ["pitches", "球数"], ["h", "被安打"], ["hr", "被本塁打"], ["so", "奪三振"], ["bb", "与四球"], ["hbp", "与死球"], ["r", "失点"], ["er", "自責点"]];

function countAtBats(list) {
  const t = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const code of list) for (const [k, n] of Object.entries(AT_BAT[code]?.add || {})) t[k] += n;
  return t;
}

// ---------------------------------------------------------------- 表示部品
const teamName = () => state.settings?.teamName || "自チーム";
const shortName = (s, n = 6) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : s || "");
const scoreText = (g) => (g.our_score === null || g.our_score === undefined ? "-" : `${g.our_score}-${g.their_score}`);

function kindChip(kind) {
  const [label, cls] = KIND[kind] || KIND.friendly;
  return html`<span class="chip ${cls}">${label}</span>`;
}

function resultMark(r, { big = false, live = false } = {}) {
  if (live) return html`<span class="result gm-result-live ${big ? "gm-result-big" : ""}" aria-label="試合中">LIVE</span>`;
  if (!r) return html`<span class="result gm-result-none ${big ? "gm-result-big" : ""}">−</span>`;
  return html`<span class="result result-${r} ${big ? "gm-result-big" : ""}">${RESULT_LABEL[r]}</span>`;
}

// スコアボード（先攻→後攻の順）
function scoreboard(g, { name = teamName(), hits = null, theirHits = null, mini = false } = {}) {
  const us = g.line_us || [];
  const them = g.line_them || [];
  const n = Math.max(g.innings || 7, us.length, them.length);
  const ours = { name: shortName(name, mini ? 5 : 6), line: us, score: g.our_score, h: hits, us: true };
  const theirs = { name: shortName(g.opponent, mini ? 5 : 6), line: them, score: g.their_score, h: theirHits };
  const rows = g.bat_first ? [ours, theirs] : [theirs, ours];
  const [top, bottom] = rows;
  // 後攻チームがリードしてサヨナラ不要だった最終回は「X」
  const xInning =
    g.status === "final" && bottom.line.length === top.line.length - 1 && (bottom.score ?? 0) > (top.score ?? 0) ? top.line.length - 1 : -1;
  const cell = (row, i) => {
    const val = row.line[i];
    if (row === bottom && i === xInning) return "X";
    return val === null || val === undefined ? "" : val;
  };
  return html`<div class="scoreboard gm-board ${mini ? "gm-board-mini" : ""}">
    <table>
      <thead><tr><th></th>${Array.from({ length: n }, (_, i) => html`<th>${i + 1}</th>`)}<th class="gm-sb-r">R</th><th>H</th></tr></thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr class="${r.us ? "gm-us" : ""}">
            <td class="team">${r.name}</td>
            ${Array.from({ length: n }, (_, i) => html`<td>${cell(r, i)}</td>`)}
            <td class="total gm-sb-r">${r.score ?? ""}</td>
            <td class="gm-sb-h">${r.h ?? ""}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

// 打撃のひとこと「3打数2安打1本塁打」
function lineText(t) {
  if (!t.pa) return "";
  let s = `${t.ab}打数${t.h}安打`;
  if (t.hr) s += `${t.hr}本塁打`;
  if (t.rbi) s += `${t.rbi}打点`;
  if (t.sb) s += `${t.sb}盗塁`;
  if (!t.ab && t.bb + t.hbp) s = `${t.bb + t.hbp}四死球`;
  return s;
}

// ---------------------------------------------------------------- 試合フォーム
function gameForm(g = {}, candidates = []) {
  const innings = g.innings ?? state.settings?.inningsPerGame ?? 7;
  const batFirst = g.bat_first ?? 1;
  const kind = g.kind || "friendly";
  return html`<form class="form" data-game-form>
    ${candidates.length
      ? html`<div class="field">
          <span class="field-label">日程から選ぶ</span>
          <div class="gm-cands">
            ${candidates.map(
              (e) => html`<button type="button" class="gm-cand" data-act="pick-event" data-id="${e.id}">
                <span class="gm-cand-date num">${fmtDate(e.date)}</span>
                <span class="gm-cand-title">vs ${e.opponent || e.title}</span>
                <span class="gm-cand-sub">${relDay(e.date)}${e.venue ? ` ・ ${e.venue}` : ""}</span>
              </button>`,
            )}
          </div>
          <p class="hint">選ぶと日付・相手・球場が入ります（出欠がスタメン候補になります）</p>
        </div>`
      : ""}
    <input type="hidden" name="eventId" value="" />
    <div class="grid-2">
      <div class="field"><label>日付</label><input class="input" type="date" name="date" required value="${g.date || ""}" /></div>
      <div class="field"><label>イニング</label>
        <select class="select" name="innings">${Array.from({ length: 12 }, (_, i) => i + 1).map((n) => html`<option value="${n}" ${n === innings ? "selected" : ""}>${n}回</option>`)}</select>
      </div>
    </div>
    <div class="field"><label>対戦相手</label><input class="input" name="opponent" required maxlength="40" placeholder="例：川口クラブ" value="${g.opponent || ""}" /></div>
    <div class="field"><label>球場</label><input class="input" name="venue" maxlength="60" placeholder="例：荒川河川敷A面" value="${g.venue || ""}" /></div>
    <div class="field"><span class="field-label">種別</span>
      <div class="pills">${Object.entries(KIND).map(
        ([k, [label, , icon]]) => html`<label class="pill"><input type="radio" name="kind" value="${k}" ${k === kind ? "checked" : ""} /><span>${icon} ${label}</span></label>`,
      )}</div>
    </div>
    <div class="field"><span class="field-label">攻撃</span>
      <div class="pills">
        <label class="pill"><input type="radio" name="batFirst" value="1" ${batFirst ? "checked" : ""} /><span>先攻（表）</span></label>
        <label class="pill"><input type="radio" name="batFirst" value="0" ${batFirst ? "" : "checked"} /><span>後攻（裏）</span></label>
      </div>
    </div>
    <button class="btn btn-primary btn-block" type="submit">${g.id ? "保存する" : "試合を作成"}</button>
  </form>`;
}

async function openCreate() {
  let candidates = [];
  try {
    ({ events: candidates } = await get("/games/candidates"));
  } catch {}
  sheet({
    title: "試合を作成",
    body: gameForm({ date: todayStr() }, candidates),
    onMount(el, close) {
      const form = el.querySelector("form");
      on(el, "click", "[data-act=pick-event]", (_, b) => {
        const e = candidates.find((x) => x.id === Number(b.dataset.id));
        el.querySelectorAll(".gm-cand").forEach((x) => x.classList.toggle("active", x === b));
        form.eventId.value = e.id;
        form.date.value = e.date;
        form.opponent.value = e.opponent || e.title;
        form.venue.value = e.venue || "";
      });
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const { game } = await post("/games", readForm(form));
          close();
          toast("試合を作成しました。プレイボール！", { type: "success" });
          navigate(`/games/${game.id}`);
        });
      });
    },
  });
}

// ---------------------------------------------------------------- 試合一覧
async function renderList(view, { query }) {
  const admin = isAdmin();
  setHeader({ title: "試合" });
  const season = query.season ? Number(query.season) : "";
  const d = await get(`/games${season ? `?season=${season}` : ""}`);
  const s = d.summary;
  const streak = (() => {
    const done = d.games.filter((g) => g.result && g.result !== "draw");
    if (!done.length) return null;
    const r = done[0].result;
    let n = 0;
    for (const g of done) if (g.result === r) n++;
    else break;
    return n >= 2 ? { r, n } : null;
  })();

  mount(
    view,
    html`${d.seasons.length > 1 ? chipTabs(d.seasons.map((y) => [`#/games?season=${y}`, y, y === d.season]), { label: "シーズン" }) : ""}
      <section class="gm-season">
        <p class="gm-season-kicker">${d.season} SEASON</p>
        <div class="gm-season-wld">
          <div><span class="num gm-led green" data-count="${s.win}">0</span><small>勝</small></div>
          <div><span class="num gm-led red" data-count="${s.lose}">0</span><small>敗</small></div>
          <div><span class="num gm-led draw" data-count="${s.draw}">0</span><small>分</small></div>
        </div>
        <div class="gm-season-sub">
          <div><small>勝率</small><span class="num" data-count="${s.winPct ?? "x"}" data-fmt="rate">-</span></div>
          <div><small>得点</small><span class="num" data-count="${s.runs}">0</span></div>
          <div><small>失点</small><span class="num" data-count="${s.allowed}">0</span></div>
          <div><small>得失差</small><span class="num ${s.runs - s.allowed > 0 ? "green" : s.runs - s.allowed < 0 ? "red" : ""}">${s.runs - s.allowed > 0 ? "+" : ""}${s.runs - s.allowed}</span></div>
        </div>
        ${streak ? html`<p class="gm-streak ${streak.r}">${streak.r === "win" ? `🔥 ${streak.n}連勝中！` : `💪 ${streak.n}連敗中…次で止めよう！`}</p>` : ""}
      </section>
      ${d.games.length
        ? html`<div class="list gm-list">
            ${d.games.map(
              (g) => html`<a class="list-item gm-row" href="#/games/${g.id}">
                ${resultMark(g.result, { live: g.status === "draft" })}
                <div class="list-main">
                  <p class="list-title ellipsis">vs ${g.opponent}</p>
                  <p class="list-sub">${fmtDate(g.date)}${g.venue ? html` ・ ${g.venue}` : ""}</p>
                  <p class="gm-row-chips">${kindChip(g.kind)}${g.status === "draft" ? html`<span class="chip chip-amber gm-draft">入力中</span>` : ""}${g.recorded ? html`<span class="chip chip-green">記録済</span>` : ""}</p>
                </div>
                <span class="num gm-row-score ${g.status === "draft" ? "" : g.result || ""}">${scoreText(g)}</span>
              </a>`,
            )}
          </div>`
        : empty(admin ? "まだ試合がありません。右下の＋から最初の試合を作りましょう！" : "まだ試合がありません。プレイボールを待っています！", { icon: "🏟" })}
      ${admin ? fab({ label: "試合を作成", short: "試合", act: "create" }) : ""}`,
  );
  countUp(view);
  return on(view, "click", "[data-act=create]", () => openCreate());
}

// ---------------------------------------------------------------- 試合詳細
function battingTable(d) {
  const rows = d.batting.filter((b) => b.pa > 0 || b.order_no !== null || (b.position && b.position !== "控え"));
  if (!rows.length) return empty("まだ打撃成績がありません", { icon: "🏏" });
  const t = Object.fromEntries([...COUNT_KEYS, "rbi", "r", "sb", "e"].map((k) => [k, 0]));
  for (const b of rows) for (const k of Object.keys(t)) t[k] += b[k];
  return html`<div class="table-wrap"><table class="table gm-box">
    <thead><tr><th>選手</th><th>打数</th><th>安打</th><th>打点</th><th>得点</th><th>本塁打</th><th>三振</th><th>四死球</th><th>盗塁</th><th>打率</th><th class="gm-ab-col">打席結果</th></tr></thead>
    <tbody>
      ${rows.map((b) => {
        const abs = d.atBats[b.member_id] || [];
        return html`<tr class="${b.member_id === state.member.id ? "gm-me" : ""}">
          <td><span class="gm-box-no num">${b.order_no ?? ""}</span><span class="gm-box-pos">${b.position && b.position !== "控え" ? b.position : ""}</span>${shortName(b.member?.name, 7)}</td>
          ${b.pa
            ? html`<td>${b.ab}</td><td class="${b.h ? "amber" : ""}">${b.h}</td><td>${b.rbi}</td><td>${b.r}</td><td class="${b.hr ? "amber" : ""}">${b.hr}</td><td>${b.so}</td><td>${b.bb + b.hbp}</td><td>${b.sb}</td><td>${fmtRate(battingRates(b).avg)}</td>`
            : html`<td colspan="9" class="gm-box-none">未入力</td>`}
          <td class="gm-ab-col">${abs.map((c) => html`<span class="gm-ab-mini ${AT_BAT[c]?.kind}">${AT_BAT[c]?.short}</span>`)}</td>
        </tr>`;
      })}
      <tr class="total"><td>合計</td><td>${t.ab}</td><td>${t.h}</td><td>${t.rbi}</td><td>${t.r}</td><td>${t.hr}</td><td>${t.so}</td><td>${t.bb + t.hbp}</td><td>${t.sb}</td><td>${fmtRate(battingRates(t).avg)}</td><td></td></tr>
    </tbody>
  </table></div>`;
}

function pitchingTable(d) {
  if (!d.pitching.length) return empty("まだ投手成績がありません", { icon: "🥎" });
  return html`<div class="table-wrap"><table class="table gm-box">
    <thead><tr><th>投手</th><th>勝敗</th><th>投球回</th><th>打者</th><th>球数</th><th>被安打</th><th>被本</th><th>奪三振</th><th>四球</th><th>死球</th><th>失点</th><th>自責</th></tr></thead>
    <tbody>
      ${d.pitching.map(
        (p) => html`<tr class="${p.member_id === state.member.id ? "gm-me" : ""}">
          <td>${shortName(p.member?.name, 7)}</td>
          <td>${p.decision ? html`<span class="chip ${DECISION[p.decision][1]}">${DECISION[p.decision][0]}</span>` : ""}</td>
          <td>${fmtIP(p.outs)}</td><td>${p.bf}</td><td>${p.pitches}</td><td>${p.h}</td><td>${p.hr}</td><td class="${p.so ? "amber" : ""}">${p.so}</td><td>${p.bb}</td><td>${p.hbp}</td><td>${p.r}</td><td>${p.er}</td>
        </tr>`,
      )}
    </tbody>
  </table></div>`;
}

// スタメン発表ボード
function lineupBoard(game, starters, bench, { animate = false, name = teamName() } = {}) {
  if (!starters.length && !bench.length) return empty("スタメンはまだ発表されていません", { icon: "📋" });
  return html`<section class="lu-board ${animate ? "lu-animate" : ""}">
    <div class="lu-lights" aria-hidden="true"></div>
    <p class="lu-kicker">STARTING LINEUP</p>
    <h2 class="lu-title">本日のスタメン</h2>
    <p class="lu-match">${fmtDate(game.date)} ${name} vs ${game.opponent}</p>
    <ol class="lu-list">
      ${starters.map(
        (x, i) => html`<li class="lu-row" style="--i:${i}">
          <span class="lu-no num">${x.orderNo ?? i + 1}</span>
          <span class="lu-pos" title="${POS_NAME[x.position] || ""}">${x.position || "−"}</span>
          ${avatar(x.member, "sm")}
          <span class="lu-name">${x.member?.number ? html`<span class="uni num">${x.member.number}</span>` : ""}${x.member?.name || "?"}</span>
        </li>`,
      )}
    </ol>
    ${bench.length ? html`<p class="lu-bench" style="--i:${starters.length}"><b>控え</b>${bench.map((x) => x.member?.name).join("・")}</p>` : ""}
  </section>`;
}

function lineupMessage(game, starters, bench) {
  return flexMessage(
    `【スタメン発表】${fmtDate(game.date)} vs ${game.opponent}`,
    listBubble({
      label: "STARTING LINEUP",
      title: `スタメン発表 vs ${game.opponent}`,
      sub: `${fmtDate(game.date)}${game.venue ? ` ${game.venue}` : ""}`,
      accent: "#ffc83d",
      sections: [
        { heading: "打順", color: "#128a52", rows: starters.map((x) => [x.member?.name || "?", POS_NAME[x.position] || x.position || ""]) },
        ...(bench.length ? [{ heading: "控え", lines: [bench.map((x) => x.member?.name).join("・")] }] : []),
      ],
      url: appUrl(`/games/${game.id}`),
      buttonLabel: "アプリで見る",
    }),
  );
}

function splitLineup(rows, byId) {
  const list = rows
    .filter((r) => r.order_no !== null || r.position !== null)
    .map((r) => ({ memberId: r.member_id, orderNo: r.order_no, position: r.position, member: r.member || byId?.get(r.member_id) }));
  return {
    starters: list.filter((x) => x.orderNo !== null).sort((a, b) => a.orderNo - b.orderNo),
    bench: list.filter((x) => x.orderNo === null),
  };
}

// MVP のおすすめ（ざっくり貢献度）
function mvpScore(d, memberId) {
  const b = d.batting.find((x) => x.member_id === memberId);
  const p = d.pitching.find((x) => x.member_id === memberId);
  let s = 0;
  if (b) s += b.h * 2 + b.d2 + b.d3 * 2 + b.hr * 4 + b.rbi * 2 + b.r + b.sb + b.bb * 0.5;
  if (p) s += p.outs * 0.5 + p.so - p.er * 2 + (p.decision === "W" ? 6 : p.decision === "S" ? 3 : 0);
  return s;
}

async function renderDetail(view, { params, query }) {
  const id = Number(params.id);
  const admin = isAdmin();
  let tab = query.tab || "batting";
  setHeader({ title: "試合", back: "/games" });
  let d = await get(`/games/${id}`);
  let firstDraw = true;

  const draw = () => {
    const g = d.game;
    const meId = state.member.id;
    const myBat = d.batting.find((b) => b.member_id === meId);
    const myPitch = d.pitching.find((p) => p.member_id === meId);
    const recorded = (myBat && myBat.pa > 0) || !!myPitch;
    const pendingMe = d.pending.some((m) => m.id === meId);
    const hits = d.batting.reduce((a, b) => a + b.h, 0);
    const theirHits = d.pitching.length ? d.pitching.reduce((a, p) => a + p.h, 0) : null;
    const { starters, bench } = splitLineup(d.batting);
    const canRecord = g.status !== "final" || admin;
    const res = g.result;
    setHeader({
      title: `vs ${g.opponent}`,
      back: "/games",
      actions: admin ? html`<button class="icon-btn" data-act="menu" aria-label="管理者メニュー">⋯</button>` : "",
    });
    mount(
      view,
      html`<section class="gm-hero gm-hero-${g.status === "draft" ? "none" : res || "none"}">
          <div class="gm-hero-top">
            ${kindChip(g.kind)}
            ${g.status === "final" ? html`<span class="chip chip-green">確定</span>` : html`<span class="chip chip-amber">入力中</span>`}
            <span class="spacer"></span>
            <span class="small muted">${fmtDate(g.date, { year: true })}</span>
          </div>
          <p class="gm-hero-word ${firstDraw ? "pop" : ""}">${g.status === "draft" ? (g.our_score === null ? "PLAY BALL" : "LIVE") : { win: "WIN", lose: "LOSE", draw: "DRAW" }[res] || "GAME SET"}</p>
          <div class="gm-hero-score">
            <div class="gm-hero-team"><span>${teamName()}</span><b class="num" data-count="${g.our_score ?? "x"}">${g.our_score ?? "-"}</b></div>
            <span class="gm-hero-dash">−</span>
            <div class="gm-hero-team"><span>${g.opponent}</span><b class="num" data-count="${g.their_score ?? "x"}">${g.their_score ?? "-"}</b></div>
          </div>
          ${g.venue ? html`<p class="gm-hero-venue">📍 ${g.venue}</p>` : ""}
        </section>
        ${scoreboard(g, { hits, theirHits })}
        ${admin && g.status === "draft"
          ? html`<div class="gm-admin-bar">
              <a class="btn btn-sm" href="#/games/${id}/score">🔢 スコア</a>
              <a class="btn btn-sm" href="#/games/${id}/lineup">📋 スタメン</a>
              <button class="btn btn-sm btn-amber" data-act="finalize">🏁 確定</button>
            </div>`
          : ""}
        ${d.mvp
          ? html`<div class="card gm-mvp">
              <span class="gm-mvp-crown">👑</span>${avatar(d.mvp, "lg")}
              <div class="grow"><p class="gm-mvp-label">MVP</p><p class="gm-mvp-name">${memberLabel(d.mvp)}</p>
              <p class="small muted">${lineText({ ...(d.batting.find((b) => b.member_id === d.mvp.id) || { pa: 0 }) })}</p></div>
            </div>`
          : ""}
        ${canRecord
          ? pendingMe
            ? html`<a class="btn btn-amber btn-block gm-cta" href="#/games/${id}/record">✍️ 自分の成績を入力する</a>`
            : html`<a class="btn btn-ghost btn-block" href="#/games/${id}/record">${recorded ? "✏️ 自分の成績を見る・直す" : "✍️ 出場した人は自分の成績を入力"}</a>`
          : ""}
        ${d.pending.length
          ? html`<div class="card card-flat gm-pending">
              <div class="card-head"><p class="card-title"><span class="icon">⏳</span>成績未入力 ${d.pending.length}人</p>${admin ? html`<span class="card-sub">タップで代理入力</span>` : ""}</div>
              <div class="gm-pending-list">
                ${d.pending.map((m) =>
                  admin && canRecord
                    ? html`<a class="gm-pending-item" href="#/games/${id}/record?member=${m.id}">${avatar(m, "sm")}<span>${m.name}</span></a>`
                    : html`<span class="gm-pending-item">${avatar(m, "sm")}<span>${m.name}</span></span>`,
                )}
              </div>
            </div>`
          : ""}
        ${segmented("tab", [["batting", "打撃"], ["pitching", "投手"], ["lineup", "スタメン"]], tab)}
        <div class="gm-tab">
          ${tab === "batting" ? battingTable(d) : tab === "pitching" ? pitchingTable(d) : html`${lineupBoard(g, starters, bench)}
              ${starters.length ? html`<button class="btn btn-line btn-block" data-act="share-lineup">LINEでスタメン発表</button>` : ""}
              ${admin ? html`<a class="btn btn-ghost btn-block" href="#/games/${id}/lineup">スタメンを編集</a>` : ""}`}
        </div>
        ${g.memo ? html`<div class="card card-flat"><p class="card-title" style="margin-bottom:8px">📝 メモ</p><p class="gm-memo">${multiline(g.memo)}</p></div>` : ""}
        ${g.our_score !== null ? html`<button class="btn btn-line btn-block" data-act="share">LINEで結果を共有</button>` : ""}`,
    );
    if (firstDraw) countUp(view);
    firstDraw = false;
  };
  draw();

  const reload = async () => {
    d = await get(`/games/${id}`);
    draw();
  };

  const openFinalize = () => {
    const g = d.game;
    if (g.our_score === null) {
      toast("先にスコアを入力してください", { type: "error" });
      return navigate(`/games/${id}/score`);
    }
    const ids = new Set([...d.participants.map((m) => m.id), ...d.batting.filter((b) => b.pa > 0).map((b) => b.member_id), ...d.pitching.map((p) => p.member_id)]);
    const people = [...ids]
      .map((mid) => d.participants.find((m) => m.id === mid) || d.batting.find((b) => b.member_id === mid)?.member || d.pitching.find((p) => p.member_id === mid)?.member)
      .filter(Boolean)
      .map((m) => ({ m, s: mvpScore(d, m.id) }))
      .sort((a, b) => b.s - a.s);
    const pick = g.mvp_member_id ?? (people[0]?.s > 0 ? people[0].m.id : null);
    sheet({
      title: "試合を確定する",
      body: html`<form class="form">
        <p class="gm-fin-score"><span class="result result-${g.result}">${RESULT_LABEL[g.result]}</span> <b class="num">${g.our_score} - ${g.their_score}</b> vs ${g.opponent}</p>
        <div class="field"><span class="field-label">MVP を選ぶ</span>
          <div class="gm-mvp-pick">
            <label class="gm-mvp-opt"><input type="radio" name="mvp" value="" ${pick ? "" : "checked"} /><span>なし</span></label>
            ${people.map(
              ({ m, s }, i) => html`<label class="gm-mvp-opt"><input type="radio" name="mvp" value="${m.id}" ${m.id === pick ? "checked" : ""} />
                <span>${avatar(m, "sm")}${m.name}${i === 0 && s > 0 ? html`<em>おすすめ</em>` : ""}</span></label>`,
            )}
          </div>
        </div>
        ${d.pending.length ? html`<p class="hint">⚠️ 成績未入力が${d.pending.length}人います（確定後も管理者は編集できます）</p>` : ""}
        <button class="btn btn-amber btn-block" type="submit">🏁 試合を確定する</button>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const mvp = readForm(form).mvp;
            await patch(`/games/${id}`, { mvpMemberId: mvp ? Number(mvp) : null });
            if (g.status !== "final") await post(`/games/${id}/finalize`, {});
            close();
            await reload();
            if (d.game.result === "win") {
              celebrate();
              toast("勝利おめでとう！🎉 試合を確定しました", { type: "success", ms: 3500 });
            } else toast("試合を確定しました", { type: "success" });
          });
        });
      },
    });
  };

  const openEdit = () =>
    sheet({
      title: "試合情報を編集",
      body: html`${gameForm(d.game)}
        <div class="field" style="margin-top:14px"><label>メモ</label><textarea class="textarea" data-memo maxlength="1000" placeholder="試合の振り返り・反省点など">${d.game.memo || ""}</textarea></div>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const body = readForm(form);
            delete body.eventId;
            body.memo = el.querySelector("[data-memo]").value;
            await patch(`/games/${id}`, body);
            close();
            toast("保存しました", { type: "success" });
            await reload();
          });
        });
      },
    });

  const openMenu = () => {
    const g = d.game;
    sheet({
      title: "管理者メニュー",
      body: html`<div class="list">
        <a class="list-item" href="#/games/${id}/score" data-sheet-close><span>🔢</span><span class="list-main list-title">スコアを入力</span><span class="chev">›</span></a>
        <a class="list-item" href="#/games/${id}/lineup" data-sheet-close><span>📋</span><span class="list-main list-title">スタメンを決める</span><span class="chev">›</span></a>
        <button class="list-item" data-menu="edit"><span>✏️</span><span class="list-main list-title">試合情報・メモを編集</span><span class="chev">›</span></button>
        ${g.status === "final"
          ? html`<button class="list-item" data-menu="mvp"><span>👑</span><span class="list-main list-title">MVP を選び直す</span><span class="chev">›</span></button>
              <button class="list-item" data-menu="reopen"><span>↩️</span><span class="list-main list-title">確定を取り消す</span><span class="chev">›</span></button>`
          : html`<button class="list-item" data-menu="finalize"><span>🏁</span><span class="list-main list-title">試合を確定する</span><span class="chev">›</span></button>`}
        <button class="list-item" data-menu="delete"><span>🗑</span><span class="list-main list-title red">試合を削除</span><span class="chev">›</span></button>
      </div>`,
      onMount(el, close) {
        on(el, "click", "[data-menu]", async (_, b) => {
          const act = b.dataset.menu;
          close();
          if (act === "edit") openEdit();
          if (act === "finalize" || act === "mvp") openFinalize();
          if (act === "reopen") {
            if (!(await confirmDialog("確定を取り消して入力中に戻しますか？メンバーが成績を直せるようになります。", { ok: "取り消す" }))) return;
            try {
              await post(`/games/${id}/reopen`);
              toast("入力中に戻しました");
              await reload();
            } catch (err) {
              toastError(err);
            }
          }
          if (act === "delete") {
            if (!(await confirmDialog(`vs ${g.opponent}（${fmtDate(g.date)}）の試合と全員の成績を削除します。元に戻せません。`, { ok: "削除する", danger: true }))) return;
            try {
              await del(`/games/${id}`);
              toast("削除しました");
              navigate("/games", { replace: true });
            } catch (err) {
              toastError(err);
            }
          }
        });
      },
    });
  };

  const shareResult = () => {
    const g = d.game;
    const label = { win: "勝利！", lose: "敗戦", draw: "引き分け" }[g.result] || "";
    const highlights = d.batting
      .filter((b) => b.h >= 2 || b.hr || b.rbi >= 2)
      .slice(0, 5)
      .map((b) => `${b.member?.name} ${lineText(b)}`);
    const win = d.pitching.find((p) => p.decision === "W");
    if (win) highlights.push(`勝利投手 ${win.member?.name}（${fmtIP(win.outs)}回 ${win.so}奪三振）`);
    share([
      flexMessage(
        `【試合結果】${teamName()} ${g.our_score}-${g.their_score} ${g.opponent} ${label}`,
        resultBubble(g, { teamName: teamName(), url: appUrl(`/games/${id}`), mvp: d.mvp?.name, highlights }),
      ),
    ]);
  };

  const offs = [
    on(view, "click", "[data-segmented=tab] button", (_, b) => {
      tab = b.dataset.value;
      history.replaceState(null, "", `#/games/${id}?tab=${tab}`);
      draw();
    }),
    on(view, "click", "[data-act=finalize]", openFinalize),
    on(view, "click", "[data-act=share]", shareResult),
    on(view, "click", "[data-act=share-lineup]", () => {
      const { starters, bench } = splitLineup(d.batting);
      share([lineupMessage(d.game, starters, bench)]);
    }),
    on($("#page-actions"), "click", "[data-act=menu]", openMenu),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- スコア入力
async function renderScore(view, { params }) {
  const id = Number(params.id);
  setHeader({ title: "スコア入力", back: `/games/${id}` });
  if (!isAdmin()) return mount(view, empty("スコアは管理者が入力します", { icon: "🔒" }));
  const { game: g } = await get(`/games/${id}`);
  let us = [...(g.line_us || [])];
  let them = [...(g.line_them || [])];
  let n = Math.max(g.innings || 7, us.length, them.length);
  let mode = !g.line_us && !g.line_them && g.our_score !== null ? "total" : "line";
  const order = g.bat_first ? ["us", "them"] : ["them", "us"];
  const label = { us: teamName(), them: g.opponent };

  const cell = (key, i, val) => html`<div class="sc-cell" data-stepper>
    <button type="button" class="stepper-btn" data-step="-1" aria-label="${label[key]} ${i + 1}回を減らす">−</button>
    <input class="stepper-input num" name="${key}${i}" type="number" inputmode="numeric" min="0" max="99" placeholder="-" value="${val ?? ""}" />
    <button type="button" class="stepper-btn" data-step="1" aria-label="${label[key]} ${i + 1}回を増やす">＋</button>
  </div>`;

  const collect = () => {
    const form = view.querySelector("form");
    const read = (k) => Array.from({ length: n }, (_, i) => {
      const el = form.elements[`${k}${i}`];
      return !el || el.value === "" ? null : Number(el.value);
    });
    if (mode === "line") {
      us = read("us");
      them = read("them");
    }
  };
  const total = (line) => line.reduce((a, b) => a + (b || 0), 0);

  const draw = () => {
    mount(
      view,
      html`<div class="sc-live">
          <div><span>${shortName(label[order[0]], 7)}</span><b class="num" data-total="${order[0]}">0</b></div>
          <span class="sc-live-dash">−</span>
          <div><span>${shortName(label[order[1]], 7)}</span><b class="num" data-total="${order[1]}">0</b></div>
        </div>
        ${segmented("mode", [["line", "イニングごと"], ["total", "合計だけ"]], mode)}
        <form class="form" id="score-form">
          ${mode === "line"
            ? html`<div class="sc-grid">
                <div class="sc-head"><span></span><span>${shortName(label[order[0]], 6)}<small>先攻</small></span><span>${shortName(label[order[1]], 6)}<small>後攻</small></span></div>
                ${Array.from({ length: n }, (_, i) => html`<div class="sc-row ${i >= (g.innings || 7) ? "sc-extra" : ""}">
                  <span class="sc-inn num">${i + 1}<small>回</small></span>
                  ${order.map((k) => cell(k, i, (k === "us" ? us : them)[i]))}
                </div>`)}
              </div>
              <div class="row gap">
                <button type="button" class="btn btn-ghost grow" data-act="less" ${n <= 1 ? "disabled" : ""}>− イニング</button>
                <button type="button" class="btn grow" data-act="more">＋ 延長</button>
              </div>
              <p class="hint">空欄は「攻撃なし」（サヨナラ・コールドなど）。合計は自動で計算します。</p>`
            : html`<div class="card card-flat">
                ${stepper(`${order[0]}Total`, label[order[0]], order[0] === "us" ? g.our_score ?? 0 : g.their_score ?? 0, { max: 999 })}
                ${stepper(`${order[1]}Total`, label[order[1]], order[1] === "us" ? g.our_score ?? 0 : g.their_score ?? 0, { max: 999 })}
              </div>
              <p class="hint">イニングごとの得点が分からないときは合計だけでもOK</p>`}
          <div class="savebar"><button class="btn btn-primary btn-block" type="submit">スコアを保存</button></div>
        </form>`,
    );
    updateTotals();
  };

  const updateTotals = () => {
    const form = view.querySelector("form");
    let t;
    if (mode === "line") {
      collect();
      t = { us: total(us), them: total(them) };
    } else t = { us: Number(form.elements.usTotal.value) || 0, them: Number(form.elements.themTotal.value) || 0 };
    for (const k of ["us", "them"]) view.querySelector(`[data-total=${k}]`).textContent = t[k];
    const lead = t.us > t.them ? "win" : t.us < t.them ? "lose" : "draw";
    view.querySelector(".sc-live").dataset.lead = lead;
  };

  draw();
  const offs = [
    bindSteppers(view),
    on(view, "input", "input", updateTotals),
    on(view, "click", "[data-segmented=mode] button", (_, b) => {
      if (mode === "line") collect();
      mode = b.dataset.value;
      draw();
    }),
    on(view, "click", "[data-act=more]", () => {
      collect();
      n = Math.min(20, n + 1);
      draw();
    }),
    on(view, "click", "[data-act=less]", () => {
      collect();
      n = Math.max(1, n - 1);
      us = us.slice(0, n);
      them = them.slice(0, n);
      draw();
    }),
    on(view, "submit", "form", (e) => {
      e.preventDefault();
      const form = e.target;
      busy(form.querySelector("[type=submit]"), async () => {
        let body;
        if (mode === "line") {
          collect();
          body = { lineUs: us.slice(0, n), lineThem: them.slice(0, n) };
        } else body = { lineUs: null, lineThem: null, ourScore: Number(form.elements.usTotal.value) || 0, theirScore: Number(form.elements.themTotal.value) || 0 };
        const { game } = await put(`/games/${id}/score`, body);
        toast(`${game.our_score ?? "-"} - ${game.their_score ?? "-"} で保存しました`, { type: "success" });
        navigate(`/games/${id}`, { replace: true });
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- スタメン
async function renderLineup(view, { params }) {
  const id = Number(params.id);
  setHeader({ title: "スタメン", back: `/games/${id}` });
  if (!isAdmin()) {
    navigate(`/games/${id}?tab=lineup`, { replace: true });
    return;
  }
  const d = await get(`/games/${id}/lineup`);
  const byId = new Map(d.candidates.map((c) => [c.member.id, c.member]));
  const att = new Map(d.candidates.map((c) => [c.member.id, c.attendance]));
  let starters = d.lineup.filter((x) => x.orderNo !== null).map((x) => ({ memberId: x.memberId, position: x.position || "" }));
  let bench = d.lineup.filter((x) => x.orderNo === null).map((x) => ({ memberId: x.memberId, position: "控え" }));
  const used = () => new Set([...starters, ...bench].map((x) => x.memberId));
  const ATT = { yes: ["出席", "chip-green"], maybe: ["未定", "chip-amber"], no: ["欠席", "chip-red"] };

  const defaultPos = (m) => {
    const taken = new Set(starters.map((x) => x.position));
    return (m.positions || []).find((p) => !taken.has(p)) || POSITIONS.find((p) => !taken.has(p) && p !== "DH") || "";
  };

  const row = (x, i, isBench) => {
    const m = byId.get(x.memberId);
    const dup = !isBench && x.position && x.position !== "DH" && starters.filter((y) => y.position === x.position).length > 1;
    return html`<div class="lu-edit ${isBench ? "lu-edit-bench" : ""}">
      <span class="lu-edit-no num">${isBench ? "控" : i + 1}</span>
      <div class="lu-edit-name">${avatar(m, "sm")}<span class="ellipsis">${m?.name || "?"}</span></div>
      ${isBench
        ? html`<button type="button" class="btn btn-sm" data-act="to-start" data-i="${i}">打順へ</button>`
        : html`<select class="select lu-pos-select ${dup ? "dup" : ""}" data-act="pos" data-i="${i}" aria-label="守備位置">
            <option value="">守備</option>
            ${POSITIONS.map((p) => html`<option value="${p}" ${x.position === p ? "selected" : ""}>${p}</option>`)}
          </select>
          <button type="button" class="icon-btn lu-mv" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="打順を上げる">▲</button>
          <button type="button" class="icon-btn lu-mv" data-act="down" data-i="${i}" ${i === starters.length - 1 ? "disabled" : ""} aria-label="打順を下げる">▼</button>`}
      <button type="button" class="icon-btn lu-mv" data-act="${isBench ? "rm-bench" : "rm"}" data-i="${i}" aria-label="外す">✕</button>
    </div>`;
  };

  const draw = () => {
    const rest = d.candidates.filter((c) => !used().has(c.member.id));
    mount(
      view,
      html`<section class="lu-editor">
          <div class="lu-editor-head">
            <p class="lu-kicker">STARTING LINEUP</p>
            <p class="lu-match">${fmtDate(d.game.date)} vs ${d.game.opponent}</p>
          </div>
          ${starters.length ? starters.map((x, i) => row(x, i, false)) : html`<p class="lu-hint">下のメンバーから「打順」をタップして1番から並べよう</p>`}
          ${bench.length ? html`<p class="lu-sub">控え</p>${bench.map((x, i) => row(x, i, true))}` : ""}
        </section>
        <p class="section-title">メンバーから追加 <span class="small muted">${d.game.event_id ? "出席の人が上に来ます" : ""}</span></p>
        ${rest.length
          ? html`<div class="list">
              ${rest.map(
                (c) => html`<div class="list-item lu-cand">
                  ${avatar(c.member, "sm")}
                  <div class="list-main"><p class="list-title ellipsis">${memberLabel(c.member)}</p>
                    <p class="list-sub">${c.attendance ? html`<span class="chip ${ATT[c.attendance][1]}">${ATT[c.attendance][0]}</span>` : d.game.event_id ? "未回答" : ""} ${c.member.positions.join("・")}</p></div>
                  <button type="button" class="btn btn-sm btn-primary" data-act="add" data-id="${c.member.id}">打順</button>
                  <button type="button" class="btn btn-sm" data-act="add-bench" data-id="${c.member.id}">控え</button>
                </div>`,
              )}
            </div>`
          : html`<p class="muted small center">全員が入っています</p>`}
        <div class="savebar"><button class="btn btn-primary btn-block" data-act="save">📣 スタメンを保存して発表</button></div>`,
    );
  };
  draw();

  const swap = (a, b) => ([starters[a], starters[b]] = [starters[b], starters[a]]);
  const offs = [
    on(view, "click", "[data-act]", (e, b) => {
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === "pos") return;
      if (act === "add") {
        const m = byId.get(Number(b.dataset.id));
        starters.push({ memberId: m.id, position: defaultPos(m) });
        navigator.vibrate?.(8);
      } else if (act === "add-bench") bench.push({ memberId: Number(b.dataset.id), position: "控え" });
      else if (act === "up" && i > 0) swap(i, i - 1);
      else if (act === "down" && i < starters.length - 1) swap(i, i + 1);
      else if (act === "rm") starters.splice(i, 1);
      else if (act === "rm-bench") bench.splice(i, 1);
      else if (act === "to-start") {
        const [x] = bench.splice(i, 1);
        starters.push({ memberId: x.memberId, position: defaultPos(byId.get(x.memberId)) });
      } else if (act === "save") return save(b);
      else return;
      draw();
    }),
    on(view, "change", "[data-act=pos]", (_, sel) => {
      starters[Number(sel.dataset.i)].position = sel.value;
      draw();
    }),
  ];

  function save(btn) {
    busy(btn, async () => {
      const lineup = [
        ...starters.map((x, i) => ({ memberId: x.memberId, orderNo: i + 1, position: x.position || null })),
        ...bench.map((x) => ({ memberId: x.memberId, orderNo: null, position: "控え" })),
      ];
      await put(`/games/${id}/lineup`, { lineup });
      const s = starters.map((x, i) => ({ ...x, orderNo: i + 1, member: byId.get(x.memberId) }));
      const bn = bench.map((x) => ({ ...x, member: byId.get(x.memberId) }));
      celebrate();
      sheet({
        title: "スタメン発表！",
        wide: true,
        body: html`${lineupBoard(d.game, s, bn, { animate: true })}
          <div class="stack" style="margin-top:14px">
            <button class="btn btn-line btn-block" data-act="share-lineup">LINEでスタメン発表</button>
            <a class="btn btn-ghost btn-block" href="#/games/${id}?tab=lineup" data-sheet-close>試合ページへ</a>
          </div>`,
        onMount(el) {
          on(el, "click", "[data-act=share-lineup]", () => share([lineupMessage(d.game, s, bn)]));
        },
      });
    });
  }
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 成績入力
async function renderRecord(view, { params, query }) {
  const id = Number(params.id);
  const memberId = Number(query.member || state.member.id);
  const self = memberId === state.member.id;
  setHeader({ title: self ? "成績入力" : "代理入力", back: `/games/${id}` });
  const d = await get(`/games/${id}/batting/${memberId}`);
  const g = d.game;
  const b = d.batting || {};
  let atBats = [...d.atBats];
  let mode = !atBats.length && b.pa > 0 ? "num" : "ab";
  let pitchOn = !!d.pitching || b.position === "投";
  const p = d.pitching || {};
  const hadPitching = !!d.pitching;

  const abSection = () => html`<section data-mode="ab" ${mode === "ab" ? "" : "hidden"}>
    <div class="card rec-ab">
      <div class="rec-summary" data-summary></div>
      <div class="rec-chips" data-chips></div>
    </div>
    <div class="rec-pad">
      ${AB_GROUPS.map(
        ([label, codes]) => html`<p class="rec-pad-label">${label}</p>
          <div class="rec-pad-row">${codes.map((c) => html`<button type="button" class="rec-btn ${AT_BAT[c].kind}" data-ab="${c}" ${d.canEdit ? "" : "disabled"}>${AT_BAT[c].label}</button>`)}</div>`,
      )}
    </div>
  </section>`;

  mount(
    view,
    html`<div class="rec-player">
        ${avatar(d.member, "lg")}
        <div class="grow">
          <p class="rec-name">${memberLabel(d.member)}${self ? "" : html` <span class="chip chip-purple">代理入力</span>`}</p>
          <p class="small muted">${fmtDate(g.date)} vs ${g.opponent}${b.order_no ? ` ・ ${b.order_no}番` : ""}${b.position ? ` ${POS_NAME[b.position] || b.position}` : ""}</p>
        </div>
      </div>
      ${d.canEdit ? "" : html`<p class="chip chip-red" style="align-self:flex-start">${g.status === "final" ? "確定済みのため編集できません（管理者に連絡してください）" : "本人か管理者だけが編集できます"}</p>`}
      <form class="form ${d.canEdit ? "" : "gm-locked"}" id="rec-form" ${d.canEdit ? "" : raw("inert")}>
        <p class="section-title">🏏 打撃</p>
        ${segmented("mode", [["ab", "1打席ずつ記録"], ["num", "数字で入力"]], mode)}
        ${abSection()}
        <section data-mode="num" ${mode === "num" ? "" : "hidden"} class="card card-flat">
          ${COUNT_KEYS.map((k) => stepper(`n_${k}`, COUNT_LABEL[k], b[k] ?? 0))}
        </section>
        <div class="card card-flat">${EXTRA.map(([k, label]) => stepper(`x_${k}`, label, b[k] ?? 0))}</div>

        <p class="section-title">⚾ 投手 <label class="pill rec-toggle"><input type="checkbox" data-act="pitch-on" ${pitchOn ? "checked" : ""} /><span>登板した</span></label></p>
        <section class="card card-flat" data-pitch ${pitchOn ? "" : "hidden"}>
          <div class="rec-ip">
            <div><p class="rec-ip-label">投球回</p><p class="rec-ip-value num" data-ip>${fmtIP(p.outs || 0)}<small>回</small></p></div>
            <div class="row gap"><button type="button" class="btn btn-sm" data-act="inning" data-n="-3">−1回</button><button type="button" class="btn btn-sm btn-primary" data-act="inning" data-n="3">＋1回</button></div>
          </div>
          ${stepper("p_outs", "アウト数", p.outs || 0, { max: 99 })}
          ${PITCH.map(([k, label]) => stepper(`p_${k}`, label, p[k] ?? 0, { max: k === "pitches" ? 400 : 99 }))}
          <div class="field" style="margin-top:8px"><span class="field-label">勝敗</span>
            <div class="pills rec-decision">
              ${[["", "なし"], ["W", "勝利"], ["L", "敗戦"], ["S", "セーブ"], ["H", "ホールド"]].map(
                ([val, label]) => html`<label class="pill"><input type="radio" name="decision" value="${val}" ${(p.decision || "") === val ? "checked" : ""} /><span>${label}</span></label>`,
              )}
            </div>
          </div>
        </section>
        ${d.canEdit ? html`<div class="savebar"><button class="btn btn-primary btn-block" type="submit">💾 成績を保存</button></div>` : ""}
      </form>`,
  );
  const form = $("#rec-form", view);
  if (!d.canEdit) form.querySelectorAll("input, button, select").forEach((el) => (el.disabled = true));
  const num = (name) => Number(form.elements[name]?.value) || 0;
  const setNum = (name, val) => {
    const el = form.elements[name];
    el.value = Math.max(0, Math.min(Number(el.max), val));
  };

  const drawAtBats = () => {
    const t = countAtBats(atBats);
    const avg = t.ab ? fmtRate(t.h / t.ab) : "-";
    mount(
      $("[data-summary]", view),
      html`<div class="rec-sum"><b class="num">${t.pa}</b><small>打席</small></div>
        <div class="rec-sum"><b class="num">${t.ab}</b><small>打数</small></div>
        <div class="rec-sum hit"><b class="num">${t.h}</b><small>安打</small></div>
        <div class="rec-sum hr"><b class="num">${t.hr}</b><small>本塁打</small></div>
        <div class="rec-sum"><b class="num">${avg}</b><small>打率</small></div>`,
    );
    mount(
      $("[data-chips]", view),
      atBats.length
        ? html`${atBats.map(
            (c, i) => html`<button type="button" class="rec-chip ${AT_BAT[c].kind}" data-rm="${i}" ${d.canEdit ? "" : "disabled"} aria-label="第${i + 1}打席 ${AT_BAT[c].label}を取り消す">
              <small>${i + 1}</small>${AT_BAT[c].label}<i>✕</i></button>`,
          )}`
        : html`<p class="rec-chips-empty">下のボタンで打席の結果を順番にタップ！</p>`,
    );
  };
  drawAtBats();

  const syncNumFromAtBats = () => {
    const t = countAtBats(atBats);
    for (const k of COUNT_KEYS) setNum(`n_${k}`, t[k]);
  };

  const offs = [
    bindSteppers(view),
    on(view, "click", "[data-ab]", (_, btn) => {
      if (atBats.length >= 15) return toast("打席数が多すぎます", { type: "error" });
      const code = btn.dataset.ab;
      atBats.push(code);
      // 本塁打は得点・打点 +1、犠飛は打点 +1 を自動で
      if (code === "HR") {
        setNum("x_r", num("x_r") + 1);
        setNum("x_rbi", num("x_rbi") + 1);
        btn.classList.remove("boom");
        void btn.offsetWidth;
        btn.classList.add("boom");
      }
      if (code === "SF") setNum("x_rbi", num("x_rbi") + 1);
      navigator.vibrate?.(code === "HR" ? [20, 30, 40] : 8);
      drawAtBats();
      const chips = $("[data-chips]", view).children;
      chips[chips.length - 1]?.classList.add("new");
    }),
    on(view, "click", "[data-rm]", (_, btn) => {
      const [code] = atBats.splice(Number(btn.dataset.rm), 1);
      if (code === "HR") {
        setNum("x_r", num("x_r") - 1);
        setNum("x_rbi", num("x_rbi") - 1);
      }
      if (code === "SF") setNum("x_rbi", num("x_rbi") - 1);
      drawAtBats();
    }),
    on(view, "click", "[data-segmented=mode] button", (_, btn) => {
      if (btn.dataset.value === mode) return;
      if (btn.dataset.value === "num") syncNumFromAtBats();
      else if (!atBats.length && num("n_pa") > 0) toast("打席の結果を順番にタップして記録し直してください");
      mode = btn.dataset.value;
      view.querySelectorAll("[data-segmented=mode] button").forEach((x) => x.classList.toggle("active", x === btn));
      view.querySelectorAll("section[data-mode]").forEach((s) => (s.hidden = s.dataset.mode !== mode));
    }),
    on(view, "change", "[data-act=pitch-on]", (_, cb) => {
      pitchOn = cb.checked;
      $("[data-pitch]", view).hidden = !pitchOn;
    }),
    on(view, "click", "[data-act=inning]", (_, btn) => {
      setNum("p_outs", num("p_outs") + Number(btn.dataset.n));
      form.elements.p_outs.dispatchEvent(new Event("input", { bubbles: true }));
    }),
    on(view, "input", "[name=p_outs]", () => mount($("[data-ip]", view), html`${fmtIP(num("p_outs"))}<small>回</small>`)),
    on(view, "submit", "#rec-form", (e) => {
      e.preventDefault();
      const btn = form.querySelector("[type=submit]");
      const extra = Object.fromEntries(EXTRA.map(([k]) => [k, num(`x_${k}`)]));
      const counts = mode === "ab" ? countAtBats(atBats) : Object.fromEntries(COUNT_KEYS.map((k) => [k, num(`n_${k}`)]));
      const errs = validateBatting({ ...counts, ...extra });
      if (pitchOn) {
        const v = (k) => num(`p_${k}`);
        if (v("er") > v("r")) errs.push("自責点が失点より多くなっています");
        if (v("hr") > v("h")) errs.push("被本塁打が被安打より多くなっています");
        if (v("bf") > 0 && v("h") + v("bb") + v("hbp") + v("so") > v("bf")) errs.push("被安打・四死球・奪三振の合計が打者数を超えています");
        if (v("bf") > 0 && v("pitches") > 0 && v("pitches") < v("bf")) errs.push("球数が打者数より少なくなっています");
      }
      if (errs.length) return toast(errs.join("／"), { type: "error", ms: 4500 });
      busy(btn, async () => {
        await put(`/games/${id}/batting/${memberId}`, mode === "ab" ? { atBats, ...extra } : { ...counts, ...extra });
        let pitchSaved = null;
        if (pitchOn) {
          const body = { outs: num("p_outs"), decision: readForm(form).decision || null };
          for (const [k] of PITCH) body[k] = num(`p_${k}`);
          ({ pitching: pitchSaved } = await put(`/games/${id}/pitching/${memberId}`, body));
        } else if (hadPitching) await del(`/games/${id}/pitching/${memberId}`);
        const t = { ...counts, ...extra };
        const who = self ? "本日" : `${d.member.name}さん`;
        let msg = t.pa ? `${who} ${lineText(t)}！` : "保存しました";
        if (pitchSaved) msg += ` ${fmtIP(pitchSaved.outs)}回${pitchSaved.so ? `${pitchSaved.so}奪三振` : ""}`;
        if (t.hr) msg = `⚾💥 ${msg} ナイスホームラン！`;
        else if (t.h >= 3) msg = `🔥 ${msg} 猛打賞！`;
        else if (pitchSaved?.decision === "W") msg = `🏆 ${msg} 勝利投手！`;
        else if (t.pa && !t.h && t.ab) msg += " 次はかっ飛ばそう！";
        if (t.hr || t.h >= 3 || pitchSaved?.decision === "W") celebrate();
        toast(msg, { type: "success", ms: 4200 });
        navigate(`/games/${id}`, { replace: true });
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- ホームカード
async function pendingCard() {
  const { games } = await get("/games/pending");
  if (!games.length) return "";
  return html`<div class="card card-hero gm-home-pending" data-todo="${games.length}">
    <div class="card-head"><p class="card-title"><span class="icon">✍️</span>成績を入力しよう！</p><span class="badge">${games.length}</span></div>
    <p class="small muted" style="margin:-4px 0 12px">LINEで送らなくてOK。ここで入力すればチーム成績に反映されます</p>
    <div class="stack">
      ${games.map(
        (g) => html`<a class="btn btn-amber btn-block gm-home-btn" href="#/games/${g.id}/record">
          <span>${fmtDate(g.date)} vs ${g.opponent}</span><span>入力する ›</span></a>`,
      )}
    </div>
  </div>`;
}

async function latestCard() {
  const d = await get("/games/latest");
  if (!d.game) return "";
  const g = d.game;
  const live = g.status === "draft";
  return html`<a class="card card-link gm-home-latest gm-hero-${live ? "none" : g.result || "none"}" href="#/games/${g.id}">
    <div class="card-head">
      <p class="card-title"><span class="icon">🏟</span>${live ? "試合速報" : "最新の試合結果"}</p>
      <span class="small muted">${fmtDate(g.date)}</span>
    </div>
    <div class="gm-latest-main">
      ${resultMark(g.result, { big: true, live })}
      <div class="grow">
        <p class="gm-latest-score num">${g.our_score ?? "-"} <span>-</span> ${g.their_score ?? "-"}</p>
        <p class="small muted">vs ${g.opponent} ・ ${KIND[g.kind]?.[0] || ""}${g.status === "draft" ? " ・ 入力中" : ""}</p>
      </div>
      <span class="chev">›</span>
    </div>
    ${scoreboard(g, { hits: d.hits, theirHits: d.theirHits, mini: true, name: d.teamName })}
    ${d.mvp ? html`<p class="gm-latest-mvp">👑 MVP ${avatar(d.mvp, "xs")} <b>${d.mvp.name}</b></p>` : ""}
  </a>`;
}

export default {
  name: "games",
  routes: {
    "/games": renderList,
    "/games/:id": renderDetail,
    "/games/:id/score": renderScore,
    "/games/:id/lineup": renderLineup,
    "/games/:id/record": renderRecord,
  },
  homeCards: [
    { order: 11, render: pendingCard },
    { order: 30, render: latestCard },
  ],
  menu: [],
};

// 他機能から使えるように
export { scoreboard, AT_BAT };
