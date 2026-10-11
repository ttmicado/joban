// 共通 UI 部品。どの機能からも import して使う。
import { $, esc, html, mount, on, raw, shareToLine, state } from "./core.js";
import { fmtNum, fmtRate } from "./lib/stats.js";

// ---------------------------------------------------------------- トースト
let toastTimer;
export function toast(msg, { type = "info", ms = 2600 } = {}) {
  const el = $("#toast");
  el.textContent = msg;
  el.dataset.type = type; // info / success / error
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
export const toastError = (err) => toast(err?.message || String(err), { type: "error", ms: 4000 });

// ---------------------------------------------------------------- ボトムシート
// const s = sheet({ title: "予定を追加", body: html`<form>...</form>`, onMount: (el, close) => {} });
// s.close() で閉じる。閉じたら onClose が呼ばれる。
export function sheet({ title = "", body = "", onMount, onClose, wide = false } = {}) {
  const root = $("#sheet-root");
  const el = document.createElement("div");
  el.className = "sheet";
  mount(
    el,
    html`<div class="sheet-backdrop" data-sheet-close></div>
      <section class="sheet-panel ${wide ? "sheet-wide" : ""}" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="sheet-grip" data-sheet-close></div>
        <header class="sheet-head">
          <h2>${title}</h2>
          <button class="icon-btn" data-sheet-close aria-label="閉じる">✕</button>
        </header>
        <div class="sheet-body">${body}</div>
      </section>`,
  );
  root.append(el);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => el.classList.add("open"));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.remove("open");
    setTimeout(() => {
      el.remove();
      if (!root.childElementCount) document.body.classList.remove("no-scroll");
    }, 280);
    onClose?.();
  };
  on(el, "click", "[data-sheet-close]", close);
  onMount?.(el.querySelector(".sheet-body"), close);
  return { el, close };
}

// 確認ダイアログ。OK で true
export function confirmDialog(message, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    sheet({
      title: "確認",
      body: html`<p class="confirm-msg">${message}</p>
        <div class="row gap">
          <button class="btn btn-ghost grow" data-sheet-close>キャンセル</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"} grow" data-ok>${ok}</button>
        </div>`,
      onMount(el, close) {
        el.querySelector("[data-ok]").onclick = () => {
          answered = true;
          resolve(true);
          close();
        };
      },
      onClose: () => !answered && resolve(false),
    });
  });
}

// ---------------------------------------------------------------- フォーム
// <form> の値をオブジェクトに。data-type="number" の input は数値、checkbox は boolean、
// 同名の checkbox が複数あれば配列になる。
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") {
      const group = form.querySelectorAll(`input[type=checkbox][name="${el.name}"]`);
      if (group.length > 1) {
        out[el.name] ??= [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
      else out[el.name] ??= null;
    } else if (el.dataset.type === "number" || el.type === "number") {
      out[el.name] = el.value === "" ? null : Number(el.value);
    } else out[el.name] = el.value;
  }
  return out;
}

// ボタンを処理中表示にして fn を実行。失敗したらトースト
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("is-busy");
  try {
    return await fn();
  } catch (err) {
    toastError(err);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-busy");
  }
}

// 数値の +/- ステッパー（成績入力用）。readForm で数値として読める
export function stepper(name, label, value = 0, { min = 0, max = 99 } = {}) {
  return html`<div class="stepper" data-stepper>
    <span class="stepper-label">${label}</span>
    <div class="stepper-ctrl">
      <button type="button" class="stepper-btn" data-step="-1" aria-label="${label}を減らす">−</button>
      <input class="stepper-input num" name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" value="${value ?? 0}" data-type="number" />
      <button type="button" class="stepper-btn" data-step="1" aria-label="${label}を増やす">＋</button>
    </div>
  </div>`;
}
// ステッパーを使う画面で1回呼ぶ（イベント委譲）
export function bindSteppers(root) {
  return on(root, "click", "[data-step]", (e, btn) => {
    const input = btn.closest("[data-stepper]").querySelector("input");
    const next = Math.min(Number(input.max), Math.max(Number(input.min), (Number(input.value) || 0) + Number(btn.dataset.step)));
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    navigator.vibrate?.(5);
  });
}

// セグメントコントロール（タブ切り替え）: segmented("tab", [["a","A"],["b","B"]], "a")
export function segmented(name, options, value) {
  return html`<div class="segmented" role="tablist" data-segmented="${name}">
    ${options.map(
      ([v, label]) => html`<button type="button" role="tab" class="${v === value ? "active" : ""}" data-value="${v}" aria-selected="${v === value}">${label}</button>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------- 表示部品
// style 属性の background-image 用に安全な url("...") を作る。http(s) 以外は空文字。
// 属性値ではエスケープした ' " が元に戻るため、CSS の url() から抜けられる文字は %エンコードしておく
export function cssUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  let enc;
  try {
    enc = encodeURI(decodeURI(s));
  } catch {
    enc = encodeURI(s);
  }
  enc = enc.replace(/['"()\\\s<>]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  return `url("${enc}")`;
}
// 画像付き要素の style 属性（raw で返す。画像が無い/不正なら空）
export const bgImage = (u) => {
  const url = cssUrl(u);
  return url ? raw(` style="background-image:${esc(url)}"`) : "";
};

export function avatar(m, size = "md") {
  if (!m) return html`<span class="avatar avatar-${size}"></span>`;
  const style = bgImage(m.picture);
  return html`<span class="avatar avatar-${size}"${style}>${String(style) ? "" : (m.name || "?").slice(0, 1)}</span>`;
}

// 名前＋背番号の表示
export function memberLabel(m) {
  if (!m) return html`<span class="muted">不明</span>`;
  return html`<span class="member-label">${m.number ? html`<span class="uni num">${m.number}</span>` : ""}${m.name}</span>`;
}

export function empty(message, { icon = "⚾", action = "" } = {}) {
  return html`<div class="empty"><p class="empty-icon">${icon}</p><p>${message}</p>${action}</div>`;
}

export const loading = () => html`<div class="loading" role="status" aria-label="読み込み中"><span></span><span></span><span></span></div>`;

// 画面右下の作成ボタン（各一覧画面の「＋追加」はこれに統一する）
// fab({ label: "予定を追加", act: "new-event" }) / fab({ label: "練習を記録", href: "#/practice/new" })
// label は aria-label と横に出す短い文字（short）に使う
export function fab({ label, short = "", icon = "＋", act = "", href = "" }) {
  const inner = html`<span class="fab-icon" aria-hidden="true">${icon}</span>${short ? html`<span class="fab-label">${short}</span>` : ""}`;
  const cls = `fab ${short ? "fab-ext" : ""}`;
  return href
    ? html`<a class="${cls}" href="${href}" aria-label="${label}">${inner}</a>`
    : html`<button type="button" class="${cls}" data-act="${act}" aria-label="${label}">${inner}</button>`;
}

// 横スクロールするタブ状のチップ（シーズン切り替えなど）
// chipTabs([["#/games?season=2026", "2026", true], ...], { label: "シーズン" })
export function chipTabs(items, { label = "" } = {}) {
  return html`<nav class="chip-tabs" aria-label="${label}">
    ${items.map(([href, text, active]) => html`<a class="chip-tab ${active ? "active" : ""}" href="${href}" ${active ? raw('aria-current="page"') : ""}>${text}</a>`)}
  </nav>`;
}

// ---------------------------------------------------------------- 数字のカウントアップ
// <span data-count="8">0</span>。data-fmt: rate（.333）/ dec2（2.50）/ dec1 / count（既定）
// 数字以外（"x" など）は "-" 表示。小数を含む値で data-fmt が無ければ小数1桁
export function fmtCount(v, fmt) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  if (fmt === "rate") return fmtRate(v);
  if (fmt === "dec2") return fmtNum(v, 2);
  if (fmt === "dec1") return fmtNum(v, 1);
  return String(Math.round(v));
}
export function countUp(root, { duration = 900 } = {}) {
  const els = [...root.querySelectorAll("[data-count]")];
  if (!els.length) return;
  const items = els.map((el) => {
    const to = Number(el.dataset.count);
    const fmt = el.dataset.fmt || (String(el.dataset.count).includes(".") ? "dec1" : "count");
    return { el, to, fmt };
  });
  const final = () => items.forEach(({ el, to, fmt }) => (el.textContent = fmtCount(to, fmt)));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return final();
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - t, 3);
    for (const { el, to, fmt } of items) {
      if (el.isConnected && Number.isFinite(to)) el.textContent = fmtCount(to * e, fmt);
    }
    if (t < 1) requestAnimationFrame(step);
    else final();
  };
  for (const { el, to, fmt } of items) el.textContent = fmtCount(Number.isFinite(to) ? 0 : to, fmt);
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- コピー・共有
export async function copyText(text, { message = "コピーしました" } = {}) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) return toast("コピーできませんでした。長押しでコピーしてください", { type: "error" });
  }
  toast(message, { type: "success", ms: 1600 });
}

// LINE の共有ピッカーで送る。使えない環境ではその旨をトースト
export async function share(messages) {
  try {
    const ok = await shareToLine(messages);
    if (ok) toast("LINEに送りました", { type: "success" });
    else if (state.mock) toast("LINEアプリで開くと共有できます（テスト環境）");
    else toast("LINEアプリで開くと共有できます");
  } catch (err) {
    toastError(err);
  }
}

// ---------------------------------------------------------------- 日付
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const parse = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
};
export const todayStr = () => {
  const d = new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 60000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const weekday = (d) => WEEK[parse(d).getDay()];
// "10/18(土)"
export const fmtDate = (d, { year = false } = {}) => {
  if (!d) return "";
  const t = parse(d);
  return `${year ? `${t.getFullYear()}/` : ""}${t.getMonth() + 1}/${t.getDate()}(${WEEK[t.getDay()]})`;
};
// 今日から何日後か（過去は負）
export const daysFrom = (d, from = todayStr()) => Math.round((parse(d) - parse(from)) / 86400000);
// "今日" "明日" "あと3日" "3日前"
export const relDay = (d) => {
  const n = daysFrom(d);
  if (n === 0) return "今日";
  if (n === 1) return "明日";
  if (n === 2) return "明後日";
  return n > 0 ? `あと${n}日` : `${-n}日前`;
};
export const weekdayClass = (d) => ({ 0: "sun", 6: "sat" })[parse(d).getDay()] || "";

// epoch ms → "10/18 7:05" / 当日なら "7:05"
export function fmtTs(ts) {
  const d = new Date(ts);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
// "たった今" "5分前" "3時間前" "2日前"
export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`;
  return fmtTs(ts);
}

// Googleマップ検索URL
export const mapUrl = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

// 改行を <br> にしつつエスケープ（メモ表示用）
export const multiline = (s) => raw(esc(s || "").replace(/\n/g, "<br>"));

// 紙吹雪（ちょっとしたお祝い演出）
export function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#ffc83d", "#27d17f", "#4da3ff", "#ff5a5f", "#ffffff"];
  const box = document.createElement("div");
  box.className = "celebrate";
  for (let i = 0; i < 60; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.setProperty("--x", `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty("--r", `${Math.random() * 720}deg`);
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2600);
}
