// teams.one からの取り込み画面（管理者向け）
import { get, html, isAdmin, mount, on, post, setHeader } from "../core.js";
import { celebrate, countUp, empty, fmtDate, toast, toastError } from "../ui.js";

const DEFAULT_URL = "https://teams.one/teams/joban-bulldogs";
const KIND = { league: "公式戦", tournament: "大会", friendly: "練習試合" };
const RESULT = { win: ["勝", "result-win"], lose: ["負", "result-lose"], draw: ["分", "result-draw"] };
const ACTION = {
  create: ["新規", "chip-green"],
  link: ["既存に対応付け", "chip-blue"],
  update: ["空欄を補完", "chip-blue"],
  same: ["登録済み", ""],
};
// 処理中に順番に出すメッセージ（サーバーからの進捗は無いので目安）
const STEPS = [
  [0, "選手名鑑を読み込んでいます…"],
  [2, "試合一覧のページを読み込んでいます…"],
  [4, "各試合のページを読み込んでいます…（約50試合）"],
  [12, "打撃・投手成績を解析しています…"],
  [25, "もう少しです。データを登録しています…"],
  [60, "時間がかかっています。画面を閉じずにお待ちください…"],
];

function slugOf(url) {
  const s = String(url || "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?teams\.one\/teams\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/) || s.match(/^([A-Za-z0-9-]+)$/);
  return m ? m[1] : null;
}

function guide() {
  return html`<div class="card card-hero imp-hero">
    <p class="imp-hero-ic" aria-hidden="true">📥</p>
    <h2 class="card-title">teams.one の成績を取り込む</h2>
    <p class="small muted">
      teams.one に登録してきた<strong>選手</strong>と<strong>過去の試合（スコア・打撃成績・投手成績）</strong>をこのアプリに取り込みます。
      取り込んだ試合は「成績」タブの個人成績・ランキング・選手ページに反映されます。
    </p>
    <ul class="imp-points small">
      <li>何度実行しても重複しません（2回目以降は teams.one の内容で上書き更新）</li>
      <li>アプリに同じ名前のメンバーがいれば、その人の成績として取り込みます</li>
      <li>名鑑にいない過去の出場者は「退団」扱いで登録します</li>
      <li>取り込んだ選手は後から各自が「この選手は自分」と LINE と紐付けできます</li>
    </ul>
  </div>`;
}

function progress(label) {
  return html`<div class="card imp-progress" role="status" aria-live="polite">
    <div class="imp-ball" aria-hidden="true"></div>
    <p class="strong" data-step>${label}</p>
    <div class="imp-bar"><span></span></div>
    <p class="small muted">teams.one から約50ページを読み込むため、<strong>数十秒〜1分ほど</strong>かかります。画面を閉じずにお待ちください。</p>
    <p class="hint num" data-elapsed>0秒</p>
  </div>`;
}

function seasonTable(r) {
  const ref = new Map((r.teamStats || []).map((s) => [s.season, s]));
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>年</th><th>試合</th><th>勝</th><th>敗</th><th>分</th><th>得点</th><th>失点</th></tr></thead>
    <tbody>${r.seasons.map(
      (s) => html`<tr><td>${s.season}</td><td>${s.games}</td><td>${s.win}</td><td>${s.lose}</td><td>${s.draw}</td><td>${s.runs}</td><td>${s.allowed}</td></tr>`,
    )}</tbody>
  </table></div>
  ${ref.size
    ? html`<p class="hint imp-note">参考: teams.one のチーム成績表 … ${[...ref.values()].map((s) => `${s.season}年 ${s.games}試合 ${s.win}勝${s.lose}敗${s.draw}分`).join(" ／ ")}。
        試合一覧には表に載っていない年の試合もあり、また勝敗の登録がスコアと食い違う試合はスコアどおりに集計するため、数字が違うことがあります。</p>`
    : ""}`;
}

function playerRows(list) {
  return html`<div class="list">${list.map((p) => {
    const [label, cls] = ACTION[p.action] || ["", ""];
    const hand = p.throws || p.bats ? `${p.throws || "-"}投${p.bats || "-"}打` : "";
    return html`<div class="list-item ${p.inRoster ? "" : "dim"}">
      <span class="uni num imp-uni">${p.number || "-"}</span>
      <div class="list-main">
        <p class="list-title">${p.name}${p.sourceName && p.sourceName.replace(/\s/g, "") !== p.name.replace(/\s/g, "") ? html` <span class="small muted">（${p.sourceName}）</span>` : ""}</p>
        <p class="list-sub">${[p.category, hand, p.title].filter(Boolean).join(" ・ ") || "—"}</p>
      </div>
      <div class="imp-chips">
        ${p.inRoster ? "" : html`<span class="chip chip-red">退団扱い</span>`}
        ${label ? html`<span class="chip ${cls}">${label}</span>` : ""}
      </div>
    </div>`;
  })}</div>`;
}

function gameRows(list) {
  const years = [...new Set(list.map((g) => g.season))];
  return years.map((y) => {
    const games = list.filter((g) => g.season === y);
    return html`<details class="imp-year" ${y === years[0] ? "open" : ""}>
      <summary><span class="strong">${y}年</span><span class="muted small">${games.length}試合</span></summary>
      <div class="list">${games.map((g) => {
        const [r, cls] = RESULT[g.result] || ["-", ""];
        return html`<div class="list-item">
          <span class="result ${cls}">${r}</span>
          <div class="list-main">
            <p class="list-title ellipsis">${g.opponent}</p>
            <p class="list-sub">${fmtDate(g.date)} ・ ${KIND[g.kind] || ""}${g.title ? ` ・ ${g.title}` : ""}${g.batting === null ? " ・ 成績表なし" : ""}</p>
          </div>
          <span class="num imp-score">${g.our}<small>-</small>${g.their}${g.walkOff ? html`<small class="muted">x</small>` : ""}</span>
        </div>`;
      })}</div>
    </details>`;
  });
}

function summary(r, { done }) {
  const p = r.players;
  const g = r.games;
  return html`<div class="card ${done ? "imp-done" : ""}">
    <div class="card-head">
      <h2 class="card-title">${done ? "取り込みました 🎉" : "取り込みの確認"}</h2>
      <span class="chip ${done ? "chip-green" : "chip-amber"}">${done ? "完了" : "まだ登録していません"}</span>
    </div>
    <p class="small muted">${r.teamName || r.slug} ・ ${r.pages}ページ読み込み（${Math.round(r.elapsedMs / 1000)}秒）</p>
    <div class="tiles imp-tiles">
      <div class="tile"><p class="tile-label">選手</p><p class="tile-value" data-count="${p.total}">${p.total}</p></div>
      <div class="tile"><p class="tile-label">試合</p><p class="tile-value" data-count="${g.total}">${g.total}</p></div>
      <div class="tile"><p class="tile-label">年度</p><p class="tile-value" data-count="${r.seasons.length}">${r.seasons.length}</p></div>
    </div>
    <p class="small imp-breakdown">
      選手: 新規 <b>${p.created}</b>人（うち退団扱い ${p.departed}人）・既存メンバーに対応付け <b>${p.linked}</b>人${p.updated ? ` ・空欄を補完 ${p.updated}人` : ""}${p.unchanged ? ` ・登録済み ${p.unchanged}人` : ""}<br />
      試合: 新規 <b>${g.created}</b>件・更新 <b>${g.updated}</b>件${g.skipped ? html` ・<span class="red">スキップ ${g.skipped}件</span>` : ""}
    </p>
  </div>
  <p class="section-title">年度別</p>
  ${seasonTable(r)}
  ${r.warnings.length
    ? html`<details class="card imp-warn">
        <summary><span class="chip chip-amber">確認事項 ${r.warnings.length}件</span><span class="small muted">teams.one 側のデータの食い違いなど</span></summary>
        <ul class="small">${r.warnings.map((w) => html`<li>${w}</li>`)}</ul>
      </details>`
    : ""}
  <p class="section-title">選手 ${p.total}人</p>
  ${playerRows(r.playerList)}
  <p class="section-title">試合 ${g.total}件</p>
  ${gameRows(r.gameList)}`;
}

async function renderImport(view) {
  setHeader({ title: "teams.one から取り込み", back: "/more" });
  if (!isAdmin()) {
    mount(
      view,
      html`${guide()}
        ${empty("取り込みは管理者（監督・マネージャー）が行います。取り込まれた成績は「成績」タブで見られます。", {
          icon: "🔒",
          action: html`<a class="btn" href="#/stats">成績を見る</a>`,
        })}`,
    );
    return;
  }
  let last = null;
  try {
    last = (await get("/import/last")).last;
  } catch {}
  let url = DEFAULT_URL;
  let preview = null; // ドライランの結果
  let running = false;
  let timer = null;

  const draw = (body = "") => {
    mount(
      view,
      html`${guide()}
        <form class="card form" data-form>
          <div class="field">
            <label for="imp-url">チームのURL</label>
            <input id="imp-url" class="input" name="url" type="url" inputmode="url" autocomplete="off" value="${url}" ${running ? "disabled" : ""} />
            <p class="hint">teams.one のチームページ（ログイン不要で見られる公開ページ）のURL</p>
          </div>
          ${last ? html`<p class="hint">前回の取り込み: ${new Date(last.at).toLocaleString("ja-JP")}（試合 ${last.summary?.games?.total ?? "-"}件）</p>` : ""}
          <button class="btn ${preview ? "btn-ghost" : "btn-primary"} btn-block" type="submit" data-act="dry" ${running ? "disabled" : ""}>🔍 確認する（ドライラン）</button>
        </form>
        <div data-out>${body}</div>
        ${preview && !running
          ? html`<div class="savebar imp-savebar">
              <button class="btn btn-primary btn-block" data-act="run">📥 ${preview.games.total}試合・${preview.players.total}人を取り込む</button>
            </div>`
          : ""}`,
    );
  };

  const startProgress = () => {
    const t0 = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      const el = view.querySelector("[data-elapsed]");
      if (!el) return;
      el.textContent = `${sec}秒経過`;
      const step = [...STEPS].reverse().find(([s]) => sec >= s);
      view.querySelector("[data-step]").textContent = step[1];
    }, 500);
  };

  async function exec(dryRun) {
    const slug = slugOf(url);
    if (!slug) return toast("teams.one のチームURL（https://teams.one/teams/○○）を入力してください", { type: "error" });
    running = true;
    draw(progress(STEPS[0][1]));
    view.querySelector("[data-out]").scrollIntoView({ behavior: "smooth", block: "start" });
    startProgress();
    try {
      const r = await post("/import/teamsone", { slug, dryRun });
      running = false;
      clearInterval(timer);
      if (dryRun) {
        preview = r;
        draw(summary(r, { done: false }));
      } else {
        preview = null;
        last = { at: Date.now(), summary: { games: r.games } };
        const latest = r.seasons[0]?.season;
        draw(html`${summary(r, { done: true })}
          <div class="row gap imp-links">
            <a class="btn btn-primary grow" href="#/stats">📊 成績を見る</a>
            <a class="btn grow" href="#/games${latest ? `?season=${latest}` : ""}">⚾ 試合一覧</a>
          </div>`);
        celebrate();
        toast(`${r.games.total}試合を取り込みました`, { type: "success" });
      }
      countUp(view);
      view.querySelector("[data-out]").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      running = false;
      clearInterval(timer);
      draw(preview ? summary(preview, { done: false }) : "");
      toastError(err);
    }
  }

  draw();
  const offs = [
    on(view, "submit", "[data-form]", (e) => {
      e.preventDefault();
      if (running) return;
      url = view.querySelector("#imp-url").value;
      preview = null;
      exec(true);
    }),
    on(view, "input", "#imp-url", (e, el) => {
      url = el.value;
    }),
    on(view, "click", "[data-act=run]", () => {
      if (running || !preview) return;
      url = preview.url;
      exec(false);
    }),
  ];
  return () => {
    clearInterval(timer);
    offs.forEach((off) => off());
  };
}

export default {
  name: "importer",
  routes: { "/import": renderImport },
  homeCards: [],
  menu: [{ path: "/import", label: "teams.one から取り込み", icon: "📥", order: 92 }],
};
