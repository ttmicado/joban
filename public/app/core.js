// フロントエンドのコア: ログイン・API・ルーター・テンプレート
//
// 機能モジュール（public/app/features/*.js）の形:
//   export default {
//     name: "schedule",
//     routes: { "/schedule": renderList, "/schedule/:id": renderDetail },
//     homeCards: [{ order: 10, render: async () => html`...`, bind: (el) => {} }],  // ホーム画面のカード
//     menu: [{ path: "/polls", label: "日程調整", icon: "🗳", order: 10 }],          // 「その他」メニューの項目
//   };
// ルートの描画関数: async (view, { params, query }) => cleanup?
//   view は <main> 要素。setHeader() でタイトルを設定し、mount(view, html`...`) で描画する。

export const state = {
  liffId: "",
  mock: false,
  token: "",
  user: null, // LINE プロフィール { name, picture }
  member: null, // 参加済みなら自分のメンバー情報
  settings: null, // チーム設定
  firstMember: false,
};

// ---------------------------------------------------------------- テンプレート
// html`...` は値を自動エスケープする。配列は連結、false/null/undefined は空文字。
// エスケープしたくない文字列は raw() で包む。
class Html {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Html(String(s));
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function interp(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(interp).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interp(values[i]) + strings[i + 1];
  return new Html(out);
}

export function mount(el, tpl) {
  el.innerHTML = String(tpl);
  return el;
}

// イベント委譲: on(view, "click", "[data-act=save]", (e, target) => ...)
export function on(root, type, selector, fn) {
  const handler = (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// api("GET", "/events")  → /api/team/events
export async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/team${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !state.mock && window.liff?.isLoggedIn?.()) {
    liff.logout();
    liff.login({ redirectUri: location.href });
  }
  if (!res.ok) throw new ApiError(res.status, data.error, data.message || "通信エラーが発生しました");
  return data;
}
export const get = (p) => api("GET", p);
export const post = (p, b = {}) => api("POST", p, b);
export const patch = (p, b = {}) => api("PATCH", p, b);
export const put = (p, b = {}) => api("PUT", p, b);
export const del = (p, b) => api("DELETE", p, b);

// ---------------------------------------------------------------- ログイン
export async function login() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  state.liffId = cfg.liffId;
  const params = new URLSearchParams(location.search);
  state.mock = cfg.mock && (!cfg.liffId || params.has("mock"));
  if (state.mock) {
    // ローカル確認用: ?mock=<id>&name=<名前>
    let id = params.get("mock");
    if (!id || id === "1") {
      id = localStorage.getItem("mock-id") || Math.random().toString(36).slice(2, 7);
      localStorage.setItem("mock-id", id);
    }
    state.token = `mock:${id}:${encodeURIComponent(params.get("name") || `テスト${id}`)}`;
    return true;
  }
  await liff.init({ liffId: state.liffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return false;
  }
  state.token = liff.getAccessToken();
  return true;
}

export async function refreshMe() {
  const me = await get("/me");
  state.user = me.user;
  state.member = me.member;
  state.settings = me.settings;
  state.firstMember = me.firstMember;
  document.dispatchEvent(new CustomEvent("me:changed"));
  return me;
}

export const isAdmin = () => state.member?.role === "admin";

// LINE の shareTargetPicker でグループ等に送る。使えない環境では false
export async function shareToLine(messages) {
  if (state.mock || !window.liff?.isApiAvailable?.("shareTargetPicker")) return false;
  const res = await liff.shareTargetPicker(messages);
  return !!res;
}

// アプリ内のページを開く LIFF URL（LINE で共有するリンク用）
export const appUrl = (path = "/") =>
  state.liffId ? `https://liff.line.me/${state.liffId}/#${path}` : `${location.origin}/#${path}`;

// ---------------------------------------------------------------- ルーター
const routes = [];
const homeCards = [];
const menuItems = [];
let cleanup = null;
let renderSeq = 0;

export function registerFeature(f) {
  for (const [path, render] of Object.entries(f.routes || {})) addRoute(path, render);
  homeCards.push(...(f.homeCards || []));
  menuItems.push(...(f.menu || []));
}

export function addRoute(path, render) {
  const keys = [];
  const re = new RegExp("^" + path.replace(/\/:(\w+)/g, (_, k) => (keys.push(k), "/([^/]+)")) + "/?$");
  routes.push({ path, re, keys, render });
}

export const getHomeCards = () => [...homeCards].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
export const getMenuItems = () => [...menuItems].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

export function currentPath() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path, query: Object.fromEntries(new URLSearchParams(qs || "")) };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return render();
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
  if (replace) render();
}

// アプリ内で辿ったパスの履歴（ディープリンクで開いたときは戻り先を fallback にする）
const visited = [];

export function back(fallback = "/") {
  if (visited.length > 1) history.back();
  else navigate(fallback, { replace: true });
}

// ヘッダーの設定。back: true で戻るボタン表示（文字列なら戻り先パス）
export function setHeader({ title = "", back: backTo = false, actions = "" } = {}) {
  $("#page-title").textContent = title;
  document.title = title ? `${title} | ${state.settings?.teamName || "チーム"}` : state.settings?.teamName || "チーム";
  const btn = $("#nav-back");
  btn.hidden = !backTo;
  btn.onclick = () => back(typeof backTo === "string" ? backTo : "/");
  mount($("#page-actions"), actions);
}

let guard = null;
// ルート描画前に呼ばれる関数を登録（未参加ならログイン画面へ…など）。true を返すと描画を止める
export function setGuard(fn) {
  guard = fn;
}

export async function render() {
  const seq = ++renderSeq;
  const { path, query } = currentPath();
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch {}
  }
  cleanup = null;
  const view = $("#view");
  // ページ移動時は開いているボトムシートを閉じる
  $("#sheet-root").replaceChildren();
  document.body.classList.remove("no-scroll");
  if (guard && (await guard(path))) return;

  let found = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      found = { r, params };
      break;
    }
  }
  // タブの選択状態（/players は成績タブ、/notices・/wakeup・/practice はチームタブ扱い）
  const alias = { "/players": "/stats", "/notices": "/team", "/wakeup": "/team", "/practice": "/team", "/polls": "/schedule" };
  const first = "/" + (path.split("/")[1] || "");
  const top = alias[first] || first;
  for (const a of document.querySelectorAll("#tabbar a")) a.classList.toggle("active", a.dataset.tab === top);

  // 描画中に別ページへ移動したとき古い描画を捨てるため、新しい要素に描いてから差し替える
  const page = document.createElement("div");
  page.className = "page";
  view.replaceChildren(page);
  window.scrollTo(0, 0);
  if (!found) {
    setHeader({ title: "ページが見つかりません", back: true });
    mount(page, html`<div class="empty"><p>ページが見つかりません</p><a class="btn" href="#/">ホームへ</a></div>`);
    return;
  }
  page.innerHTML = `<div class="loading"><span></span><span></span><span></span></div>`;
  try {
    const c = await found.r.render(page, { params: found.params, query });
    if (seq !== renderSeq) {
      if (typeof c === "function") c();
      return;
    }
    cleanup = c;
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    mount(
      page,
      html`<div class="empty">
        <p class="empty-icon">⚠️</p>
        <p>${err.message || "読み込みに失敗しました"}</p>
        <button class="btn" onclick="location.reload()">再読み込み</button>
      </div>`,
    );
  }
}

addEventListener("hashchange", () => {
  const { path } = currentPath();
  if (visited.length > 1 && visited[visited.length - 2] === path) visited.pop();
  else visited.push(path);
  render();
});

export function startRouter() {
  visited.push(currentPath().path);
  return render();
}
