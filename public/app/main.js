// アプリの起動・ホーム・参加・メンバー・設定・その他メニュー
import {
  $,
  addRoute,
  get,
  getHomeCards,
  getMenuItems,
  html,
  isAdmin,
  login,
  mount,
  navigate,
  on,
  patch,
  post,
  refreshMe,
  registerFeature,
  setGuard,
  setHeader,
  startRouter,
  state,
} from "./core.js";
import { avatar, busy, celebrate, empty, fab, memberLabel, readForm, sheet, toast } from "./ui.js";

import schedule from "./features/schedule.js";
import games from "./features/games.js";
import stats from "./features/stats.js";
import community from "./features/community.js";
import line from "./features/line.js";
import importer from "./features/importer.js";

const POSITIONS = ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", "DH"];

// ---------------------------------------------------------------- ホーム
async function renderHome(view) {
  setHeader({ title: "ホーム" });
  const m = state.member;
  const hour = new Date().getHours();
  const hello = hour < 5 ? "おつかれさまです" : hour < 11 ? "おはようございます" : hour < 18 ? "こんにちは" : "こんばんは";
  const cards = getHomeCards();
  mount(
    view,
    html`<div class="greet">
        <a href="#/players/${m.id}">${avatar(m, "lg")}</a>
        <div class="greet-text">
          <p class="greet-hello">${hello}</p>
          <p class="greet-name">${memberLabel(m)} さん</p>
          <p class="greet-todo" data-greet-todo aria-live="polite"></p>
        </div>
      </div>
      ${cards.map((_, i) => html`<div data-home-card="${i}"><div class="skeleton" style="height:96px"></div></div>`)}
      ${cards.length ? "" : empty("まだ機能がありません")}`,
  );
  // やること（data-todo を持つカードの件数の合計）をあいさつの下に出す。カード操作で減ったら更新
  const todoEl = view.querySelector("[data-greet-todo]");
  let loaded = false;
  const updateTodo = () => {
    const n = [...view.querySelectorAll("[data-todo]")].reduce((a, el) => a + (Number(el.dataset.todo) || 0), 0);
    const cls = `greet-todo ${n ? "has" : loaded ? "done" : ""}`;
    const text = n ? `やることが ${n} 件あります 👇` : loaded ? "やることは全部完了！ナイス 👍" : "";
    // 自分の書き換えで MutationObserver が再度呼ばれてもループしないよう、変化があるときだけ書く
    if (todoEl.className !== cls) todoEl.className = cls;
    if (todoEl.textContent !== text) todoEl.textContent = text;
  };
  const mo = new MutationObserver(updateTodo);
  mo.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-todo"] });
  // カードは並列に読み込み、できたものから表示
  await Promise.all(
    cards.map(async (card, i) => {
      const slot = view.querySelector(`[data-home-card="${i}"]`);
      try {
        const out = await card.render();
        if (!out || !String(out)) return slot.remove();
        mount(slot, out);
        card.bind?.(slot);
      } catch (err) {
        console.error(err);
        slot.remove();
      }
    }),
  );
  loaded = true;
  updateTodo();
  return () => mo.disconnect();
}

// ---------------------------------------------------------------- 参加
function positionPills(selected = []) {
  return html`<div class="pills">
    ${POSITIONS.map(
      (p) => html`<label class="pill"><input type="checkbox" name="positions" value="${p}" ${selected.includes(p) ? "checked" : ""} /><span>${p}</span></label>`,
    )}
  </div>`;
}

function profileForm(m = {}) {
  return html`<div class="field"><label>名前（チーム内での呼び名）</label><input class="input" name="name" required maxlength="30" value="${m.name || ""}" /></div>
    <div class="grid-2">
      <div class="field"><label>背番号</label><input class="input num" name="number" inputmode="numeric" maxlength="4" value="${m.number || ""}" /></div>
      <div class="field"><label>投 / 打</label>
        <div class="row gap">
          <select class="select" name="throws">${["", "右", "左"].map((x) => html`<option value="${x}" ${m.throws === x ? "selected" : ""}>${x ? `${x}投` : "投"}</option>`)}</select>
          <select class="select" name="bats">${["", "右", "左", "両"].map((x) => html`<option value="${x}" ${m.bats === x ? "selected" : ""}>${x ? `${x}打` : "打"}</option>`)}</select>
        </div>
      </div>
    </div>
    <div class="field"><label>守備位置（複数選択可）</label>${positionPills(m.positions || [])}</div>`;
}

function renderJoin(view) {
  setHeader({ title: "チームに参加" });
  mount(
    view,
    html`<div class="welcome">
        <div class="welcome-ball"></div>
        <h2>${state.settings?.teamName || "チーム"}へ<br />ようこそ！</h2>
        <p>LINEアカウントと紐づけて参加します。<br />日程・出欠・成績・連絡がここで完結します。</p>
      </div>
      <form class="card form" id="join-form">
        <div class="row gap">${avatar({ name: state.user?.name, picture: state.user?.picture }, "lg")}<div><p class="strong">${state.user?.name}</p><p class="small muted">LINEアカウント</p></div></div>
        ${profileForm({ name: state.user?.name })}
        ${state.firstMember ? html`<p class="chip chip-amber">最初の参加者なので管理者（監督・マネージャー）になります</p>` : ""}
        <button class="btn btn-primary btn-block" type="submit">参加する</button>
      </form>`,
  );
  const form = $("#join-form", view);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      await post("/join", readForm(form));
      await refreshMe();
      celebrate();
      toast("参加しました！よろしくお願いします", { type: "success" });
      showChrome();
      navigate("/", { replace: true });
    });
  });
}

// ---------------------------------------------------------------- その他
const menuRow = (href, icon, label, extra = "") =>
  html`<a class="list-item" href="${href}"><span class="menu-ic" aria-hidden="true">${icon}</span><span class="list-main list-title">${label}</span>${extra}<span class="chev" aria-hidden="true">›</span></a>`;

async function renderMore(view) {
  setHeader({ title: "その他", back: true });
  const items = getMenuItems();
  // order の十の位でまとめる（10番台=日程、30番台=成績・チーム、90番台=設定系）
  const groups = [
    ["日程・試合", items.filter((it) => (it.order ?? 50) < 30)],
    ["成績・チーム", items.filter((it) => (it.order ?? 50) >= 30 && (it.order ?? 50) < 90)],
  ];
  const settings = items.filter((it) => (it.order ?? 50) >= 90);
  mount(
    view,
    html`<a class="card card-link row gap" href="#/players/${state.member.id}">
        ${avatar(state.member, "lg")}
        <div class="grow"><p class="strong">${memberLabel(state.member)}</p><p class="small muted">${state.member.role === "admin" ? "管理者" : "メンバー"} ・ マイページ</p></div>
        <span class="chev">›</span>
      </a>
      <div class="list">
        ${menuRow("#/me/edit", "✏️", "プロフィール編集")}
        ${menuRow("#/members", "👥", "メンバー一覧")}
      </div>
      ${groups.map(([title, list]) => (list.length ? html`<p class="section-title">${title}</p><div class="list">${list.map((it) => menuRow(`#${it.path}`, it.icon || "・", it.label))}</div>` : ""))}
      <p class="section-title">設定・その他</p>
      <div class="list">
        ${settings.map((it) => menuRow(`#${it.path}`, it.icon || "・", it.label))}
        ${isAdmin() ? menuRow("#/settings", "⚙️", "チーム設定", html`<span class="chip chip-amber">管理者</span>`) : ""}
        ${menuRow("/garapon/", "🎰", "ガラポン抽選会")}
      </div>`,
  );
}

function renderEditMe(view) {
  setHeader({ title: "プロフィール編集", back: "/more" });
  mount(view, html`<form class="card form" id="me-form">${profileForm(state.member)}<button class="btn btn-primary btn-block" type="submit">保存</button></form>`);
  const form = $("#me-form", view);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      await patch("/me", readForm(form));
      await refreshMe();
      toast("保存しました", { type: "success" });
      navigate("/more", { replace: true });
    });
  });
}

// ---------------------------------------------------------------- メンバー
async function renderMembers(view) {
  const admin = isAdmin();
  setHeader({ title: "メンバー", back: "/more" });
  let { members } = await get(`/members${admin ? "?all=1" : ""}`);
  const draw = (list) =>
    mount(
      view,
      html`<p class="section-title">${list.filter((m) => m.active).length}人</p>
        <div class="list">
          ${list.map(
            (m) => html`<div class="list-item ${m.active ? "" : "dim"}">
              <a href="#/players/${m.id}">${avatar(m)}</a>
              <a class="list-main" href="#/players/${m.id}" style="color:inherit">
                <p class="list-title">${memberLabel(m)}</p>
                <p class="list-sub">${[m.positions.join("・"), m.throws && m.bats ? `${m.throws}投${m.bats}打` : ""].filter(Boolean).join(" / ") || "　"}</p>
              </a>
              ${m.role === "admin" ? html`<span class="chip chip-amber">管理者</span>` : ""}
              ${m.isGuest ? html`<span class="chip chip-purple">助っ人</span>` : ""}
              ${m.active ? "" : html`<span class="chip">退団</span>`}
              ${admin ? html`<button class="icon-btn" data-act="edit" data-id="${m.id}" aria-label="${m.name}を編集">⋯</button>` : ""}
            </div>`,
          )}
        </div>
        ${admin ? fab({ label: "助っ人を追加", short: "助っ人", act: "add-guest" }) : ""}`,
    );
  draw(members);

  const openEdit = (m) =>
    sheet({
      title: m ? `${m.name} を編集` : "助っ人を追加",
      body: html`<form class="form">
        ${profileForm(m || {})}
        ${m
          ? html`<div class="field"><label>権限</label>
              <select class="select" name="role" ${m.linked ? "" : "disabled"}>
                <option value="member" ${m.role === "member" ? "selected" : ""}>メンバー</option>
                <option value="admin" ${m.role === "admin" ? "selected" : ""}>管理者</option>
              </select></div>
              <label class="pill"><input type="checkbox" name="isGuest" ${m.isGuest ? "checked" : ""} /><span>助っ人</span></label>
              <label class="pill"><input type="checkbox" name="active" ${m.active ? "checked" : ""} /><span>在籍中</span></label>`
          : html`<p class="hint">LINEを使っていない助っ人も成績を記録できます</p>`}
        <button class="btn btn-primary btn-block" type="submit">保存</button>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const body = readForm(form);
            if (m) await patch(`/members/${m.id}`, body);
            else await post("/members", body);
            close();
            toast("保存しました", { type: "success" });
            ({ members } = await get("/members?all=1"));
            draw(members);
            await refreshMe();
          });
        });
      },
    });

  const offs = [
    on(view, "click", "[data-act=edit]", (_, b) => openEdit(members.find((m) => m.id === Number(b.dataset.id)))),
    on(view, "click", "[data-act=add-guest]", () => openEdit(null)),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- チーム設定
async function renderSettings(view) {
  setHeader({ title: "チーム設定", back: "/more" });
  const { settings } = await get("/settings");
  mount(
    view,
    html`<form class="card form" id="settings-form">
      <div class="field"><label>チーム名</label><input class="input" name="teamName" maxlength="30" value="${settings.teamName}" /></div>
      <div class="grid-2">
        <div class="field"><label>年度（シーズン）</label><input class="input num" name="season" type="number" value="${settings.season}" /></div>
        <div class="field"><label>規定イニング</label><input class="input num" name="inningsPerGame" type="number" min="1" max="12" value="${settings.inningsPerGame}" /></div>
      </div>
      <p class="hint">規定イニングは防御率の計算に使います（草野球は7回が一般的）</p>
      <div class="field"><label>ホーム球場</label><input class="input" name="homeVenue" maxlength="60" value="${settings.homeVenue}" /></div>
      <button class="btn btn-primary btn-block" type="submit">保存</button>
    </form>`,
  );
  const form = $("#settings-form", view);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      await patch("/settings", readForm(form));
      await refreshMe();
      showChrome();
      toast("保存しました", { type: "success" });
    });
  });
}

// ---------------------------------------------------------------- 起動
function showChrome() {
  $("#tabbar").hidden = !state.member;
  $("#nav-me").hidden = !state.member;
  if (state.member) mount($("#nav-me"), avatar(state.member, "sm"));
  $("#team-name").textContent = state.settings?.teamName || "";
}

async function boot() {
  for (const f of [schedule, games, stats, community, line, importer]) registerFeature(f);
  addRoute("/", renderHome);
  addRoute("/join", renderJoin);
  addRoute("/more", renderMore);
  addRoute("/me/edit", renderEditMe);
  addRoute("/members", renderMembers);
  addRoute("/settings", renderSettings);

  if (!(await login())) return;
  await refreshMe();
  showChrome();
  document.addEventListener("me:changed", showChrome);

  // 未参加なら参加画面へ
  setGuard(async (path) => {
    if (!state.member && path !== "/join") {
      navigate("/join", { replace: true });
      return true;
    }
    if (state.member && path === "/join") {
      navigate("/", { replace: true });
      return true;
    }
    return false;
  });
  await startRouter();
}

boot().catch((err) => {
  console.error(err);
  mount($("#view"), empty(`読み込みに失敗しました：${err.message}`, { icon: "⚠️" }));
});
