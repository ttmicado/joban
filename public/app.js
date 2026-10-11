import { sfx } from "./sound.js";
import { confetti } from "./confetti.js";

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAU = Math.PI * 2;
const TURNS_NEEDED = 1.5; // ガラポンを何回転させたら玉が出るか

const app = {
  liffId: "",
  mock: false,
  token: "",
  profile: null,
  me: null,
  stats: null,
  board: [],
  lastBoard: null,
};

// ---------------------------------------------------------------- API
async function api(path, { method = "GET", auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${app.token}`;
  const res = await fetch(path, { method, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !app.mock && window.liff?.isLoggedIn?.()) {
    // アクセストークン切れ → 再ログイン
    liff.logout();
    liff.login({ redirectUri: location.href });
    throw new Error(data.message || "再ログインします");
  }
  if (!res.ok) {
    const err = new Error(data.message || "通信エラーが発生しました");
    err.code = data.error;
    throw err;
  }
  apply(data);
  return data;
}

function apply(data) {
  if (data.stats) app.stats = data.stats;
  if ("me" in data) app.me = data.me;
  if (data.board) {
    announceNewWinners(data.board);
    app.board = data.board;
  }
  if (data.profile) app.profile = data.profile;
  render();
}

// ---------------------------------------------------------------- 画面遷移
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("is-active", s.id === id));
  $("#btn-board").hidden = id !== "s-intro";
  window.scrollTo(0, 0);
}

function render() {
  const s = app.stats;
  if (!s) return;
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const v = s[el.dataset.bind];
    if (v !== undefined) el.textContent = v;
  });
  renderIntroBalls();
  renderCrowd();
  renderBoard();
  renderGoldDots();
}

function renderIntroBalls() {
  const box = $("#intro-balls");
  const { total, prizes, drawn, goldRemaining } = app.stats;
  const key = `${total}/${prizes}/${drawn}/${goldRemaining}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = "";
  const goldDrawn = prizes - goldRemaining;
  // 先頭に金玉、使用済みの玉は薄く
  for (let i = 0; i < total; i++) {
    const b = document.createElement("span");
    const isGold = i < prizes;
    const used = isGold ? i < goldDrawn : i - prizes < drawn - goldDrawn;
    b.className = `mini-ball${isGold ? " gold" : ""}${used ? " used" : ""}`;
    b.style.animationDelay = `${i * 40}ms`;
    box.append(b);
  }
}

function avatar(entry, cls = "avatar") {
  const el = document.createElement("div");
  el.className = cls;
  if (entry?.picture) el.style.backgroundImage = `url("${entry.picture}")`;
  else el.textContent = (entry?.name || "?").slice(0, 1);
  return el;
}

function renderCrowd() {
  const box = $("#intro-crowd");
  const { entries, total } = app.stats;
  box.innerHTML = "";
  if (!entries) {
    box.innerHTML = `<p class="crowd-text">一番乗りでエントリーしよう！</p>`;
    return;
  }
  const faces = document.createElement("div");
  faces.className = "crowd-faces";
  app.board.slice(-8).forEach((e) => faces.append(avatar(e)));
  const text = document.createElement("p");
  text.className = "crowd-text";
  text.innerHTML = `<b>${entries}</b> / ${total}人 がエントリー済み`;
  box.append(faces, text);
}

function renderGoldDots() {
  const box = $("#spin-gold");
  const { prizes, goldRemaining } = app.stats;
  box.innerHTML = "";
  if (prizes > 6) {
    box.textContent = `${goldRemaining}個`;
    return;
  }
  for (let i = 0; i < prizes; i++) {
    const b = document.createElement("span");
    b.className = `mini-ball gold${i >= goldRemaining ? " used" : ""}`;
    box.append(b);
  }
}

function renderBoard() {
  const list = $("#board");
  const { drawn, entries, goldRemaining, prizes } = app.stats;
  $("#sheet-sub").textContent =
    goldRemaining > 0
      ? `抽選済み ${drawn} / ${entries}人 ・ 金の玉 のこり ${goldRemaining}個`
      : `金の玉 ${prizes}個 すべて出ました！`;
  list.innerHTML = "";
  if (!app.board.length) {
    list.innerHTML = `<li class="board-empty">まだ誰もエントリーしていません</li>`;
    return;
  }
  // 当選者 → 抽選済み → 未抽選 の順
  const rank = { win: 0, lose: 1, waiting: 2 };
  const sorted = [...app.board].sort((a, b) => rank[a.status] - rank[b.status] || a.no - b.no);
  for (const e of sorted) {
    const li = document.createElement("li");
    li.className = e.status;
    if (app.me && e.no === app.me.no) li.classList.add("me");
    const no = document.createElement("span");
    no.className = "b-no";
    no.textContent = String(e.no).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "b-name";
    name.textContent = e.name;
    const st = document.createElement("span");
    st.className = `b-status ${e.status}`;
    const label = { win: "当選！", lose: "ハズレ", waiting: "まだ" }[e.status];
    st.innerHTML = `<span class="mini-ball${e.status === "win" ? " gold" : ""}"></span>${label}`;
    li.append(no, avatar(e), name, st);
    list.append(li);
  }
}

// 他の人の当選をライブでお知らせ
function announceNewWinners(board) {
  if (app.lastBoard) {
    const before = new Map(app.lastBoard.map((e) => [e.no, e.status]));
    for (const e of board) {
      if (app.me && e.no === app.me.no) continue;
      const prev = before.get(e.no);
      if (e.status === "win" && prev !== "win") toast(`🎉 ${e.name}さんが金の玉を引き当てた！`);
      else if (!prev) toast(`${e.name}さんがエントリーしました`, true);
    }
  }
  app.lastBoard = board;
}

let toastTimer;
function toast(msg, plain = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("plain", plain);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------------------------------------------------------------- 起動
async function boot() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  app.liffId = cfg.liffId;
  const params = new URLSearchParams(location.search);
  app.mock = cfg.mock && (!cfg.liffId || params.has("mock"));

  if (app.mock) {
    let id = params.get("mock");
    if (!id) {
      id = localStorage.getItem("mock-id") || Math.random().toString(36).slice(2, 7);
      localStorage.setItem("mock-id", id);
    }
    app.token = `mock:${id}:${encodeURIComponent(params.get("name") || `テスト${id}`)}`;
  } else {
    await liff.init({ liffId: app.liffId });
    if (liff.isLoggedIn()) app.token = liff.getAccessToken();
  }

  await api("/api/board", { auth: false });
  if (app.token) await api("/api/me");
  route();

  if (sessionStorage.getItem("pending-entry") && app.token && !app.me) {
    sessionStorage.removeItem("pending-entry");
    doEntry();
  }
  setInterval(poll, 4000);
}

function route() {
  if (!app.me) {
    showIntro();
  } else if (!app.me.result) {
    showEntered();
  } else {
    showResult(false);
  }
}

async function poll() {
  if (document.hidden || $("#s-spin").classList.contains("is-active")) return;
  try {
    await api("/api/board", { auth: false });
  } catch {}
}

// ---------------------------------------------------------------- イントロ / エントリー
function showIntro() {
  const s = app.stats;
  const notice = $("#intro-notice");
  const btn = $("#btn-entry");
  notice.hidden = true;
  btn.disabled = false;
  if (!s.open) {
    notice.textContent = "エントリー受付は終了しました";
    notice.hidden = false;
    btn.disabled = true;
  } else if (s.entries >= s.total) {
    notice.textContent = "定員に達したため、エントリーを締め切りました";
    notice.hidden = false;
    btn.disabled = true;
  }
  show("s-intro");
}

async function doEntry() {
  sfx.unlock();
  if (!app.token) {
    sessionStorage.setItem("pending-entry", "1");
    liff.login({ redirectUri: location.href });
    return;
  }
  const btn = $("#btn-entry");
  btn.disabled = true;
  try {
    await api("/api/entry", { method: "POST" });
    sfx.stamp();
    showEntered();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

function showEntered() {
  $("#et-no").textContent = String(app.me.no).padStart(2, "0");
  $("#et-name").textContent = app.me.name;
  $("#et-avatar").replaceWith(Object.assign(avatar(app.me, "avatar avatar-lg"), { id: "et-avatar" }));
  show("s-entered");
  setTimeout(() => sfx.stamp(), 1000);
}

// ---------------------------------------------------------------- ガラポン
const g = {
  rot: 0, // ドラムの角度(rad)
  vel: 0, // rad/frame
  progress: 0, // 回した量(rad)
  dragging: false,
  lastAngle: 0,
  lastClack: 0,
  phase: "idle", // idle | play | drawing | done
  raf: 0,
};

function buildDrum() {
  const faces = $("#drum-faces");
  if (faces.childElementCount) return;
  const cx = 160, cy = 150, R = 108, r = 84;
  const ns = "http://www.w3.org/2000/svg";
  const pt = (rad, i) => {
    const a = (i / 8) * TAU + Math.PI / 8;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  // 外枠
  const outer = document.createElementNS(ns, "polygon");
  outer.setAttribute("points", [...Array(8)].map((_, i) => pt(R + 6, i).join(",")).join(" "));
  outer.setAttribute("fill", "url(#g-gold)");
  faces.append(outer);
  // 8枚の面（色違いにして回転が見えるように）
  for (let i = 0; i < 8; i++) {
    const p = document.createElementNS(ns, "polygon");
    const pts = [pt(R, i), pt(R, i + 1), pt(r, i + 1), pt(r, i)];
    p.setAttribute("points", pts.map((q) => q.join(",")).join(" "));
    p.setAttribute("fill", i % 2 ? "#b81d33" : "url(#g-red)");
    p.setAttribute("stroke", "#fff1b0");
    p.setAttribute("stroke-width", "1.5");
    faces.append(p);
  }
  const inner = document.createElementNS(ns, "polygon");
  inner.setAttribute("points", [...Array(8)].map((_, i) => pt(r, i).join(",")).join(" "));
  inner.setAttribute("fill", "url(#g-red)");
  inner.setAttribute("stroke", "#f6c445");
  inner.setAttribute("stroke-width", "3");
  faces.append(inner);
  // 「福」の文字
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", cx);
  t.setAttribute("y", cy + 52);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("font-family", "Dela Gothic One");
  t.setAttribute("font-size", "30");
  t.setAttribute("fill", "#fff1b0");
  t.textContent = "福";
  faces.append(t);
  // 玉の出口（回転0のとき真下）
  const hole = document.createElementNS(ns, "circle");
  hole.setAttribute("cx", cx);
  hole.setAttribute("cy", cy + R - 10);
  hole.setAttribute("r", "11");
  hole.setAttribute("fill", "#3b0610");
  hole.setAttribute("stroke", "#f6c445");
  hole.setAttribute("stroke-width", "3");
  faces.append(hole);
}

function showSpin() {
  buildDrum();
  Object.assign(g, { rot: 0, vel: 0, progress: 0, phase: "play", dragging: false });
  $("#ball").setAttribute("opacity", "0");
  $("#grab-hint").classList.remove("gone");
  $("#btn-auto").disabled = false;
  setMsg("ハンドルをつかんで、ぐるぐる回そう！");
  renderGoldDots();
  drawDrum();
  show("s-spin");
  cancelAnimationFrame(g.raf);
  g.raf = requestAnimationFrame(loop);
}

function setMsg(text) {
  const el = $("#spin-msg");
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

function drawDrum() {
  $("#drum").style.transform = `rotate(${g.rot}rad)`;
  const pct = Math.min(1, g.progress / (TURNS_NEEDED * TAU));
  $("#progress-bar").style.strokeDasharray = `${pct * 100} 100`;
  $("#meter-fill").style.width = `${pct * 100}%`;
}

function svgPoint(ev) {
  const svg = $("#garapon");
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / 320;
  return { x: (ev.clientX - rect.left) / scale, y: (ev.clientY - rect.top) / scale };
}

function onDown(ev) {
  if (g.phase !== "play") return;
  sfx.unlock();
  ev.preventDefault();
  $("#garapon").setPointerCapture(ev.pointerId);
  $("#garapon").classList.add("dragging");
  $("#grab-hint").classList.add("gone");
  const p = svgPoint(ev);
  g.dragging = true;
  g.lastAngle = Math.atan2(p.y - 150, p.x - 160);
  g.vel = 0;
}

function onMove(ev) {
  if (!g.dragging || g.phase !== "play") return;
  const p = svgPoint(ev);
  // 中心付近は角度が暴れるので無視
  if (Math.hypot(p.x - 160, p.y - 150) < 18) return;
  const a = Math.atan2(p.y - 150, p.x - 160);
  let d = a - g.lastAngle;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  g.lastAngle = a;
  d = Math.max(-0.6, Math.min(0.6, d));
  g.rot += d;
  g.progress += Math.abs(d);
  g.vel = g.vel * 0.5 + d * 0.5;
}

function onUp() {
  g.dragging = false;
  $("#garapon").classList.remove("dragging");
}

function loop() {
  if (g.phase === "play") {
    if (!g.dragging) {
      g.rot += g.vel;
      g.progress += Math.abs(g.vel);
      g.vel *= 0.965;
    }
    const pct = g.progress / (TURNS_NEEDED * TAU);
    if (pct > 0.02) {
      setMsg(pct < 0.35 ? "ガラガラガラ…！" : pct < 0.7 ? "いいぞ、その調子！" : "もう少し…！！");
    }
    if (pct >= 1) startDraw();
  }
  rattle();
  drawDrum();
  g.raf = requestAnimationFrame(loop);
}

// 回転量に応じて玉がぶつかる音
function rattle() {
  const step = 0.42;
  const crossed = Math.floor(g.rot / step);
  if (crossed !== g.lastClack) {
    g.lastClack = crossed;
    sfx.clack();
    if (navigator.vibrate) navigator.vibrate(4);
  }
}

async function startDraw() {
  if (g.phase !== "play") return;
  g.phase = "drawing";
  g.dragging = false;
  $("#btn-auto").disabled = true;
  $("#grab-hint").classList.add("gone");
  setMsg("出るぞ…出るぞ…！");

  const dir = Math.sign(g.vel) || 1;
  // サーバーの抽選結果を待つ間も勢いよく回す
  const request = api("/api/spin", { method: "POST" }).catch((e) => e);
  const spinUntil = performance.now() + 1500;
  sfx.drumroll(3.6);
  await new Promise((resolve) => {
    const step = () => {
      g.vel += (0.28 * dir - g.vel) * 0.08;
      g.rot += g.vel;
      g.progress += Math.abs(g.vel);
      if (performance.now() < spinUntil) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
  const res = await request;
  if (res instanceof Error) {
    sfx.stopDrumroll();
    toast(res.message, true);
    g.phase = "play";
    $("#btn-auto").disabled = false;
    if (res.code === "not_entered" || res.code === "empty") route();
    return;
  }

  // 出口が真下に来る角度に向けて減速
  const k = dir > 0 ? Math.ceil(g.rot / TAU) + 1 : Math.floor(g.rot / TAU) - 1;
  await tween(g.rot, k * TAU, 2200, (v) => (g.rot = v), easeOutCubic);
  setMsg("…！");
  const win = app.me.result.win;
  const shake = $("#drum-shake");
  shake.classList.remove("shake");
  void shake.getBoundingClientRect();
  shake.classList.add("shake");
  await sleep(win ? 1100 : 700);
  sfx.stopDrumroll();
  await dropBall(win);
  g.phase = "done";
  await reveal(win);
  showResult(true);
}

function tween(from, to, ms, set, ease) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      set(from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

async function dropBall(win) {
  const ball = $("#ball");
  ball.setAttribute("fill", win ? "url(#g-ball-gold)" : "url(#g-ball-white)");
  ball.setAttribute("opacity", "1");
  sfx.pop();
  const anim = ball.animate(
    [
      { transform: "translate(0, -2px) scale(.4)" },
      { transform: "translate(0, 50px) scale(1)", offset: 0.45, easing: "ease-out" },
      { transform: "translate(6px, 34px)", offset: 0.62, easing: "ease-in" },
      { transform: "translate(12px, 50px)", offset: 0.78, easing: "ease-out" },
      { transform: "translate(18px, 44px)", offset: 0.88, easing: "ease-in" },
      { transform: "translate(22px, 50px)" },
    ],
    { duration: 1100, fill: "forwards" },
  );
  setTimeout(() => sfx.bounce(), 480);
  setTimeout(() => sfx.bounce(0.5), 860);
  await anim.finished;
  await sleep(win ? 500 : 350);
}

// 受け皿の玉が画面いっぱいにズームする演出
async function reveal(win) {
  const ballRect = $("#ball").getBoundingClientRect();
  const el = $(".reveal-ball");
  const flash = $(".reveal-flash");
  el.className = `reveal-ball ${win ? "gold" : "white"}`;
  const cx = ballRect.left + ballRect.width / 2;
  const cy = ballRect.top + ballRect.height / 2;
  el.style.left = `${cx - 13}px`;
  el.style.top = `${cy - 13}px`;
  const dx = innerWidth / 2 - cx;
  const dy = innerHeight * 0.42 - cy;
  if (win) {
    sfx.rise();
    await el.animate(
      [
        { opacity: 1, transform: "translate(0,0) scale(1)" },
        { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(5)`, offset: 0.6 },
        { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(4.6)`, offset: 0.8 },
        { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(40)` },
      ],
      { duration: 1500, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" },
    ).finished;
    flash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
    el.style.opacity = 0;
    el.getAnimations().forEach((a) => a.cancel());
  } else {
    await el.animate(
      [
        { opacity: 1, transform: "translate(0,0) scale(1)" },
        { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(4)` },
      ],
      { duration: 700, easing: "cubic-bezier(.3,1.2,.5,1)", fill: "forwards" },
    ).finished;
    await sleep(250);
    el.getAnimations().forEach((a) => a.cancel());
    el.style.opacity = 0;
  }
}

// ---------------------------------------------------------------- 結果
function showResult(fresh) {
  cancelAnimationFrame(g.raf);
  const win = app.me.result.win;
  $("#result-win").hidden = !win;
  $("#result-lose").hidden = win;
  $("#win-name").textContent = app.me.name;
  const left = app.stats.goldRemaining;
  $("#lose-msg").innerHTML =
    left > 0
      ? `金の玉は まだ<b class="gold-text">${left}個</b> のこってる。<br />誰が当てるか、見届けよう！`
      : `宿泊券の行き先は決まりました。<br />参加ありがとうございました！`;
  const canShare = !app.mock && window.liff?.isApiAvailable?.("shareTargetPicker");
  $("#btn-share").hidden = !(win && canShare);
  show("s-result");
  if (win) {
    sfx.bell();
    setTimeout(() => sfx.fanfare(), fresh ? 300 : 0);
    confetti.burst(fresh ? 1 : 0.4);
    if (fresh && navigator.vibrate) navigator.vibrate([80, 60, 80, 60, 200]);
  } else if (fresh) {
    sfx.lose();
  }
}

async function shareResult() {
  const url = `https://liff.line.me/${app.liffId}`;
  try {
    await liff.shareTargetPicker([
      {
        type: "flex",
        altText: `${app.me.name}さんが${app.stats.prizeName}を当てました！`,
        contents: {
          type: "bubble",
          styles: { body: { backgroundColor: "#1b0d2b" } },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              { type: "text", text: "🎉 大当たり！ 🎉", color: "#f6c445", weight: "bold", size: "xl", align: "center" },
              { type: "text", text: `${app.me.name}さんが`, color: "#fff4dc", align: "center", wrap: true },
              { type: "text", text: `${app.stats.prizeName}をゲット！`, color: "#ffffff", weight: "bold", size: "xxl", align: "center", wrap: true },
              { type: "text", text: `のこり金玉 ${app.stats.goldRemaining}個`, color: "#c9b8d8", size: "sm", align: "center" },
              {
                type: "button",
                style: "primary",
                color: "#d7263d",
                action: { type: "uri", label: "ガラポンを回す", uri: url },
              },
            ],
          },
        },
      },
    ]);
  } catch (e) {
    toast("送信できませんでした", true);
  }
}

// ---------------------------------------------------------------- ボトムシート
function openSheet() {
  renderBoard();
  $("#sheet").classList.add("open");
  $("#sheet").setAttribute("aria-hidden", "false");
}
function closeSheet() {
  $("#sheet").classList.remove("open");
  $("#sheet").setAttribute("aria-hidden", "true");
}

// ---------------------------------------------------------------- イベント
$("#btn-entry").addEventListener("click", doEntry);
$("#btn-go-spin").addEventListener("click", () => {
  sfx.unlock();
  sfx.pop();
  showSpin();
});
$("#btn-auto").addEventListener("click", () => {
  if (g.phase !== "play") return;
  sfx.unlock();
  $("#grab-hint").classList.add("gone");
  g.vel = 0.32;
  // 手を離した状態の慣性で回るが、確実に規定回転に届くよう残りを足す
  g.progress = Math.max(g.progress, TURNS_NEEDED * TAU - 6);
});
const svg = $("#garapon");
svg.addEventListener("pointerdown", onDown);
svg.addEventListener("pointermove", onMove);
svg.addEventListener("pointerup", onUp);
svg.addEventListener("pointercancel", onUp);
$("#btn-board").addEventListener("click", openSheet);
$("#btn-board-2").addEventListener("click", openSheet);
$("#btn-share").addEventListener("click", shareResult);
document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));

boot().catch((e) => {
  console.error(e);
  show("s-intro");
  const n = $("#intro-notice");
  n.textContent = `読み込みに失敗しました：${e.message}`;
  n.hidden = false;
  $("#btn-entry").disabled = true;
});
