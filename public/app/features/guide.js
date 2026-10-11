// しおり（予定ごとのガイドブック）: 予定詳細の展開カード・全画面表示・管理者の編集画面
// データは GET/PUT /events/:id/guide（保存は管理者だけ）。持ち物のチェックは各自の端末（localStorage）に保存する。
import { del, get, html, isAdmin, mount, navigate, on, put, raw, setHeader } from "../core.js";
import { busy, celebrate, confirmDialog, empty, multiline, toast } from "../ui.js";

// サーバーの GUIDE_TYPES と同じ
export const GUIDE_TYPES = {
  timeline: { label: "旅程・タイムテーブル", title: "旅程", icon: "🗓" },
  stay: { label: "宿泊先", title: "宿泊先", icon: "🏠" },
  checklist: { label: "持ち物チェック", title: "持ち物", icon: "🎒" },
  rooms: { label: "部屋割り", title: "部屋割り", icon: "🛏" },
  text: { label: "自由記述", title: "メモ", icon: "📝" },
  links: { label: "リンク集", title: "リンク", icon: "🔗" },
};
const ICONS = ["🗓", "🚌", "🏠", "🎒", "🛏", "💴", "⚠️", "📞", "📝", "🔗", "⚾", "⛷", "🍖", "♨️", "🏔", "🍻"];
const typeInfo = (t) => GUIDE_TYPES[t] || GUIDE_TYPES.text;
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : "");
const WD_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WD_JA = "日月火水木金土";
const parseD = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};

// ---------------------------------------------------------------- 開閉状態（再描画しても保つ。予定ごと）
const openState = new Map(); // eventId -> { root: bool, secs: Set<sectionId> }
const stateOf = (eid) => {
  if (!openState.has(eid)) openState.set(eid, { root: false, secs: new Set() });
  return openState.get(eid);
};
// 保存直後に詳細へ戻ったときだけ開いた状態にする（次に詳細を開いたときは閉じた状態から）
export const resetGuideOpen = (eid, { root = false } = {}) => openState.set(Number(eid), { root, secs: new Set(), keep: true });
export function prepareGuideOpen(eid) {
  const st = openState.get(Number(eid));
  if (st?.keep) st.keep = false;
  else openState.set(Number(eid), { root: false, secs: new Set() });
}

// ---------------------------------------------------------------- 持ち物チェック（自分の端末だけに保存）
const ckKey = (eid, sid) => `guide-check:${eid}:${sid}`;
function loadChecks(eid, sid) {
  try {
    const v = JSON.parse(localStorage.getItem(ckKey(eid, sid)) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveChecks(eid, sid, set) {
  try {
    localStorage.setItem(ckKey(eid, sid), JSON.stringify([...set]));
  } catch {
    /* 保存できない環境（プライベートモードなど）では、その場だけのチェックになる */
  }
}
const checkedCount = (eid, s) => {
  const set = loadChecks(eid, s.id);
  return (s.items || []).filter((x) => set.has(x)).length;
};

// ---------------------------------------------------------------- 表示部品
const MOUNTAINS = raw(`<svg class="gd-mtn" viewBox="0 0 400 90" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 90 L0 62 L46 34 L78 52 L128 14 L170 46 L206 30 L250 58 L300 20 L346 50 L400 36 L400 90 Z" fill="rgba(206,226,255,0.16)"/>
  <path d="M0 90 L0 74 L60 50 L104 70 L160 40 L214 72 L268 46 L330 74 L372 58 L400 66 L400 90 Z" fill="rgba(234,243,255,0.30)"/>
  <path d="M128 14 L140 23 L132 24 L124 30 L116 22 Z M300 20 L313 30 L304 30 L296 36 L289 27 Z" fill="rgba(255,255,255,0.75)"/>
</svg>`);

function coverHtml(g, { big = false, label = "" } = {}) {
  return html`<div class="gd-cover ${big ? "big" : ""}">
    <span class="gd-snow" aria-hidden="true"></span>
    ${MOUNTAINS}
    <p class="gd-kicker">${label || "📖 しおり"}</p>
    <h3 class="gd-title">${g.title || "しおり"}</h3>
    ${g.subtitle ? html`<p class="gd-sub num">${g.subtitle}</p>` : ""}
    ${g.message ? html`<p class="gd-msg">${multiline(g.message)}</p>` : ""}
  </div>`;
}

function sectionMeta(eid, s) {
  if (s.type === "timeline") return (s.days || []).length ? `${s.days.length}日分` : "";
  if (s.type === "checklist") return (s.items || []).length ? `${checkedCount(eid, s)}/${s.items.length}` : "";
  if (s.type === "rooms") return (s.rooms || []).length ? `${s.rooms.length}部屋` : "未定";
  if (s.type === "links") return (s.links || []).length ? `${s.links.length}件` : "";
  if (s.type === "stay") return s.checkin ? `IN ${s.checkin}` : "";
  return "";
}

const blankMsg = (s, msg) => (s.note ? "" : html`<p class="gd-blank">${msg}</p>`);

function checklistProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return html`<div class="gd-prog ${total && done === total ? "done" : ""}">
    <p class="gd-prog-text">${total && done === total ? "🎉 " : ""}<b class="num">${done}</b> / <span class="num">${total}</span> 準備OK</p>
    <span class="gd-prog-bar"><i style="width:${pct}%"></i></span>
  </div>`;
}

function sectionBody(eid, s) {
  let body = "";
  if (s.type === "timeline") {
    const days = s.days || [];
    body = days.length
      ? days.map(
          (d, i) => html`<div class="gd-day">
            <p class="gd-day-label"><span class="gd-day-no num">DAY ${i + 1}</span>${d.label}</p>
            ${d.items?.length
              ? html`<ol class="gd-tl">${d.items.map((it) => html`<li class="${it.time ? "" : "no-time"}"><span class="gd-tl-time num">${it.time}</span><span class="gd-tl-text">${it.text}</span></li>`)}</ol>`
              : html`<p class="gd-blank">まだ予定はありません</p>`}
          </div>`,
        )
      : blankMsg(s, "まだ予定はありません");
  } else if (s.type === "stay") {
    const url = safeUrl(s.url);
    const map = safeUrl(s.mapUrl);
    body = html`<div class="gd-stay">
      ${s.name ? html`<p class="gd-stay-name">${s.name}</p>` : ""}
      ${s.address ? html`<p class="gd-stay-addr">📍 ${s.address}</p>` : ""}
      <div class="gd-stay-io">
        <div><p class="gd-io-label">CHECK IN</p><p class="gd-io-val">${s.checkin || "未定"}</p></div>
        <div><p class="gd-io-label">CHECK OUT</p><p class="gd-io-val">${s.checkout || "未定"}</p></div>
      </div>
      ${url || map
        ? html`<div class="gd-btns">
            ${url ? html`<a class="btn btn-amber" href="${url}" target="_blank" rel="noopener noreferrer">🏨 予約ページを開く</a>` : ""}
            ${map ? html`<a class="btn" href="${map}" target="_blank" rel="noopener noreferrer">🗺 地図</a>` : ""}
          </div>`
        : ""}
    </div>`;
  } else if (s.type === "checklist") {
    const items = s.items || [];
    const set = loadChecks(eid, s.id);
    const done = items.filter((x) => set.has(x)).length;
    body = items.length
      ? html`<div class="gd-checklist" data-gd-list="${s.id}">
          ${checklistProgress(done, items.length)}
          <div class="gd-checks">
            ${items.map(
              (x) => html`<label class="gd-check"><input type="checkbox" data-gd-check="${s.id}" value="${x}" ${set.has(x) ? "checked" : ""} /><span class="gd-box" aria-hidden="true"></span><span class="gd-check-text">${x}</span></label>`,
            )}
          </div>
          <p class="gd-hint">✓ チェックはこのスマホにだけ保存されます</p>
        </div>`
      : blankMsg(s, "まだ項目はありません");
  } else if (s.type === "rooms") {
    const rooms = s.rooms || [];
    body = rooms.length
      ? html`<div class="gd-rooms">
          ${rooms.map(
            (r) => html`<div class="gd-room">
              <p class="gd-room-name">${r.name || "部屋"}<span class="gd-room-n">${r.members.length}人</span></p>
              <div class="gd-room-members">${r.members.length ? r.members.map((m) => html`<span class="gd-member">${m}</span>`) : html`<span class="gd-blank">未定</span>`}</div>
            </div>`,
          )}
        </div>`
      : blankMsg(s, "決まり次第お知らせします");
  } else if (s.type === "links") {
    const links = (s.links || []).filter((l) => safeUrl(l.url));
    body = links.length
      ? html`<div class="gd-links">${links.map((l) => html`<a class="btn btn-block gd-link" href="${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer"><span class="ellipsis">${l.label || l.url}</span><span class="gd-ext">↗</span></a>`)}</div>`
      : blankMsg(s, "まだリンクはありません");
  } else {
    body = s.body ? html`<p class="gd-text">${multiline(s.body)}</p>` : blankMsg(s, "決まり次第お知らせします");
  }
  return html`${body}${s.note ? html`<p class="gd-note">${multiline(s.note)}</p>` : ""}`;
}

function sectionHtml(eid, s, open) {
  const meta = sectionMeta(eid, s);
  return html`<details class="gd-sec t-${s.type}" data-gd-sec="${s.id}" ${open ? "open" : ""}>
    <summary class="gd-sec-head">
      <span class="gd-sec-ic" aria-hidden="true">${s.icon || typeInfo(s.type).icon}</span>
      <span class="gd-sec-title">${s.title || typeInfo(s.type).title}</span>
      ${meta ? html`<span class="gd-sec-meta num" data-gd-meta="${s.id}">${meta}</span>` : ""}
      <span class="gd-chev" aria-hidden="true"></span>
    </summary>
    <div class="gd-sec-body">${sectionBody(eid, s)}</div>
  </details>`;
}

// 予定詳細に出す「しおり」カード（タップで展開 → セクションもタップで展開）
export function guideCardHtml(event, guide, { admin = false } = {}) {
  const eid = Number(event.id);
  if (!guide) {
    if (!admin) return "";
    return html`<section class="gd-create">
      <p class="gd-create-title">📖 しおりはまだありません</p>
      <p class="gd-create-sub">旅程・宿泊先・持ち物・部屋割りなどを1か所にまとめて、みんなに配れます</p>
      <a class="btn btn-amber btn-block" href="#/schedule/${eid}/guide/edit">＋ しおりを作る</a>
    </section>`;
  }
  const st = stateOf(eid);
  const secs = guide.sections || [];
  return html`<section class="gd-card" data-gd-event="${eid}" data-gd-eid="${eid}">
    <details class="gd-root" data-gd-root ${st.root ? "open" : ""}>
      <summary class="gd-root-head" aria-label="${guide.title || "しおり"}を開く">
        ${coverHtml(guide, { label: "📖 しおり" })}
        <span class="gd-root-bar"><span class="gd-root-hint" data-closed>タップしてしおりを開く</span><span class="gd-root-hint" data-opened>しおりを閉じる</span><span class="gd-root-count">${secs.length}項目</span><span class="gd-chev big" aria-hidden="true"></span></span>
      </summary>
      <div class="gd-root-body">
        ${secs.length ? html`<div class="gd-secs">${secs.map((s) => sectionHtml(eid, s, st.secs.has(s.id)))}</div>` : html`<p class="gd-blank">まだ中身がありません</p>`}
        <div class="gd-root-actions">
          <a class="btn btn-block" href="#/schedule/${eid}/guide">📖 しおりを全画面で開く</a>
          ${admin ? html`<a class="btn btn-ghost btn-block" href="#/schedule/${eid}/guide/edit">✏️ しおりを編集（管理者）</a>` : ""}
        </div>
      </div>
    </details>
  </section>`;
}

// 全画面・プレビュー用（すべてのセクションを開いた状態で1ページに）
function fullGuideHtml(eid, guide, { preview = false } = {}) {
  const secs = guide.sections || [];
  return html`<article class="gd-full ${preview ? "is-preview" : ""}">
    ${coverHtml(guide, { big: true, label: "📖 TRAVEL GUIDE" })}
    ${secs.length > 1
      ? html`<nav class="gd-toc" aria-label="もくじ">
          <p class="gd-toc-title">もくじ</p>
          <div class="gd-toc-list">${secs.map((s, i) => html`<button type="button" class="gd-toc-item" data-gd-jump="${s.id}"><span class="num">${String(i + 1).padStart(2, "0")}</span>${s.icon} ${s.title}</button>`)}</div>
        </nav>`
      : ""}
    <div class="gd-secs">${secs.map((s) => sectionHtml(eid, s, true))}</div>
    ${secs.length ? "" : html`<p class="gd-blank center">まだ中身がありません</p>`}
  </article>`;
}

// チェック・開閉の動き（詳細・全画面・プレビュー共通）
export function bindGuide(root) {
  const onToggle = (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLDetailsElement)) return;
    const card = el.closest("[data-gd-event]");
    if (!card) return;
    const st = stateOf(Number(card.dataset.gdEvent));
    if (el.hasAttribute("data-gd-root")) st.root = el.open;
    else if (el.dataset.gdSec) el.open ? st.secs.add(el.dataset.gdSec) : st.secs.delete(el.dataset.gdSec);
  };
  root.addEventListener("toggle", onToggle, true); // toggle はバブリングしないのでキャプチャで拾う
  const offs = [
    () => root.removeEventListener("toggle", onToggle, true),
    on(root, "change", "[data-gd-check]", (_, input) => {
      const host = input.closest("[data-gd-eid]");
      const eid = Number(host?.dataset.gdEid);
      const sid = input.dataset.gdCheck;
      const set = loadChecks(eid, sid);
      if (input.checked) set.add(input.value);
      else set.delete(input.value);
      const box = input.closest("[data-gd-list]");
      const all = [...box.querySelectorAll("[data-gd-check]")];
      for (const x of all) if (!all.some((y) => y.value === x.value && y.checked)) set.delete(x.value);
      saveChecks(eid, sid, set);
      const done = all.filter((x) => x.checked).length;
      box.querySelector(".gd-prog").outerHTML = String(checklistProgress(done, all.length));
      const meta = root.querySelector(`[data-gd-meta="${CSS.escape(sid)}"]`);
      if (meta) meta.textContent = `${done}/${all.length}`;
      navigator.vibrate?.(8);
      if (input.checked && done === all.length) {
        celebrate();
        toast("🎒 準備バッチリ！楽しんできてね", { type: "success" });
      }
    }),
    on(root, "click", "[data-gd-jump]", (_, b) => {
      const sec = root.querySelector(`[data-gd-sec="${CSS.escape(b.dataset.gdJump)}"]`);
      if (!sec) return;
      sec.open = true;
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 全画面 /schedule/:id/guide
export async function renderGuidePage(view, { params }) {
  const id = encodeURIComponent(params.id);
  const admin = isAdmin();
  setHeader({ title: "しおり", back: `/schedule/${params.id}` });
  const [d, g] = await Promise.all([get(`/events/${id}`), get(`/events/${id}/guide`)]);
  const eid = d.event.id;
  setHeader({
    title: g.guide?.title || "しおり",
    back: `/schedule/${eid}`,
    actions: admin && g.guide ? html`<a class="btn btn-sm" href="#/schedule/${eid}/guide/edit">✏️ 編集</a>` : "",
  });
  if (!g.guide) {
    mount(
      view,
      empty("この予定にはしおりがありません", {
        icon: "📖",
        action: admin ? html`<a class="btn btn-amber" href="#/schedule/${eid}/guide/edit">＋ しおりを作る</a>` : html`<a class="btn" href="#/schedule/${eid}">予定に戻る</a>`,
      }),
    );
    return;
  }
  mount(
    view,
    html`<div data-gd-eid="${eid}">${fullGuideHtml(eid, g.guide)}</div>
      <a class="btn btn-block gd-back" href="#/schedule/${eid}">← ${d.event.title} の予定・出欠へ</a>`,
  );
  return bindGuide(view);
}

// ---------------------------------------------------------------- 編集 /schedule/:id/guide/edit（管理者）
const pad2 = (n) => String(n).padStart(2, "0");
const addDays = (d, n) => {
  const t = parseD(d);
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}(${WD_JA[parseD(d).getUTCDay()]})`;
const dotDate = (d, withYear) => `${withYear ? `${d.slice(0, 4)}.` : ""}${Number(d.slice(5, 7))}.${Number(d.slice(8))} ${WD_EN[parseD(d).getUTCDay()]}`;
let seq = 0;
const newId = () => `s${Date.now().toString(36).slice(-4)}${(++seq).toString(36)}`;

function eventDays(e) {
  const out = [];
  const last = e.end_date && e.end_date > e.date ? e.end_date : e.date;
  for (let d = e.date; d <= last && out.length < 10; d = addDays(d, 1)) out.push(d);
  return out;
}

export function newSection(type, e = null) {
  const t = typeInfo(type);
  const s = { id: newId(), type, title: t.title, icon: t.icon, note: "" };
  if (type === "timeline") s.days = (e ? eventDays(e) : [null]).map((d, i) => ({ label: d ? `${md(d)} ${i + 1}日目` : "1日目", items: [] }));
  if (type === "stay") Object.assign(s, { name: e?.venue || "", address: "", url: "", mapUrl: e?.venue_url || "", checkin: "", checkout: "" });
  if (type === "checklist") s.items = [];
  if (type === "rooms") s.rooms = [];
  if (type === "text") s.body = "";
  if (type === "links") s.links = [];
  return s;
}

// しおりのテンプレート（旅程・宿泊先・持ち物・部屋割り・費用・注意事項・連絡先）
export function guideTemplate(e) {
  const multi = e.end_date && e.end_date > e.date;
  const sameYear = !multi || e.end_date.slice(0, 4) === e.date.slice(0, 4);
  const items = (e.belongings || "")
    .split(/[\n、,，・]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 40);
  const text = (title, icon, body = "") => ({ ...newSection("text"), title, icon, body });
  return {
    title: `${e.title}のしおり`.slice(0, 60),
    subtitle: multi ? `${dotDate(e.date, true)} – ${dotDate(e.end_date, !sameYear)}` : dotDate(e.date, true),
    message: "",
    sections: [
      newSection("timeline", e),
      newSection("stay", e),
      { ...newSection("checklist"), items },
      { ...newSection("rooms"), note: "決まり次第お知らせします" },
      text("費用", "💴", e.fee != null ? `${Number(e.fee).toLocaleString("ja-JP")}円${e.fee_note ? `（${e.fee_note}）` : ""}` : "決まり次第お知らせします"),
      text("注意事項", "⚠️", "・集合時間は厳守！遅れそうなときは早めに連絡してください"),
      text("連絡先", "📞"),
    ],
  };
}

// 1行1項目のテキスト ⇔ データ
const TIME_RE = /^(\d{1,2}[:：]\d{2}(?:\s*[〜~\-–]\s*(?:\d{1,2}[:：]\d{2})?)?)\s*(.*)$/;
export const timelineToText = (days) =>
  (days || []).map((d) => [`## ${d.label}`, ...(d.items || []).map((it) => (it.time ? `${it.time} ${it.text}` : it.text))].join("\n")).join("\n\n");
export function textToTimeline(text) {
  const days = [];
  for (const raw0 of String(text || "").split("\n")) {
    const line = raw0.trim();
    if (!line) continue;
    const h = /^#{1,3}\s*(.*)$/.exec(line);
    if (h) {
      days.push({ label: h[1].trim().slice(0, 40) || `${days.length + 1}日目`, items: [] });
      continue;
    }
    if (!days.length) days.push({ label: "1日目", items: [] });
    const m = TIME_RE.exec(line);
    const item = m ? { time: m[1].replace(/：/g, ":").replace(/\s+/g, ""), text: m[2].trim() } : { time: "", text: line };
    days.at(-1).items.push({ time: item.time.slice(0, 20), text: item.text.slice(0, 200) });
  }
  return days;
}
export const roomsToText = (rooms) => (rooms || []).map((r) => (r.members.length ? `${r.name}: ${r.members.join(", ")}` : r.name)).join("\n");
export function textToRooms(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.search(/[:：]/);
      const name = (i < 0 ? l : l.slice(0, i)).trim().slice(0, 40);
      const members = i < 0 ? [] : l.slice(i + 1).split(/[,、，\s]+/).map((x) => x.trim().slice(0, 30)).filter(Boolean);
      return { name, members };
    });
}
export const linksToText = (links) => (links || []).map((l) => (l.label && l.label !== l.url ? `${l.label} | ${l.url}` : l.url)).join("\n");
export function textToLinks(text) {
  const out = [];
  const bad = [];
  String(text || "")
    .split("\n")
    .forEach((l, i) => {
      const line = l.trim();
      if (!line) return;
      const p = line.lastIndexOf("|");
      const label = (p < 0 ? "" : line.slice(0, p)).trim();
      const url = (p < 0 ? line : line.slice(p + 1)).trim();
      if (!safeUrl(url)) bad.push(i + 1);
      else out.push({ label: (label || url).slice(0, 60), url });
    });
  return { links: out, bad };
}

function sectionEditor(s, i, n) {
  const t = typeInfo(s.type);
  const ta = (name, value, ph, rows = 6) => html`<textarea class="textarea gd-ta" name="${name}" rows="${rows}" placeholder="${ph}">${value}</textarea>`;
  let fields = "";
  if (s.type === "timeline") {
    fields = html`<div class="field"><label>旅程（1行1項目）</label>
      ${ta("timeline", timelineToText(s.days), "## 2/13(土) 1日目\n08:00 新宿駅西口 集合\n12:00 白馬着・昼食\n\n## 2/14(日) 2日目\n10:00 チェックアウト", 9)}
      <p class="hint">「## 見出し」で日を区切り、「08:00 集合」のように時刻＋内容を1行ずつ。時刻なしの行もOK</p></div>`;
  } else if (s.type === "stay") {
    const inp = (name, label, ph = "", type = "text", max = 100) =>
      html`<div class="field"><label>${label}</label><input class="input" type="${type}" name="${name}" maxlength="${max}" value="${s[name] || ""}" placeholder="${ph}" /></div>`;
    fields = html`${inp("name", "宿の名前", "例: コテージ 白馬 ムジェーヴ")}
      ${inp("address", "住所", "", "text", 200)}
      ${inp("url", "予約ページURL", "https://…", "url", 1000)}
      ${inp("mapUrl", "地図URL", "https://maps.app.goo.gl/…", "url", 1000)}
      <div class="grid-2">${inp("checkin", "チェックイン", "例: 15:00", "text", 40)}${inp("checkout", "チェックアウト", "例: 10:00", "text", 40)}</div>`;
  } else if (s.type === "checklist") {
    fields = html`<div class="field"><label>項目（1行に1つ）</label>${ta("items", (s.items || []).join("\n"), "グローブ\nスパイク\n防寒着", 8)}
      <p class="hint">みんなが自分のスマホでチェックを付けられます</p></div>`;
  } else if (s.type === "rooms") {
    fields = html`<div class="field"><label>部屋割り（1行1部屋）</label>${ta("rooms", roomsToText(s.rooms), "1号棟: 田代, 河村\n2号棟: 佐藤, 鈴木", 6)}
      <p class="hint">「部屋名: 名前, 名前」の形。名前は自由に書けます</p></div>`;
  } else if (s.type === "links") {
    fields = html`<div class="field"><label>リンク（1行1つ）</label>${ta("links", linksToText(s.links), "スキー場の情報 | https://…", 4)}
      <p class="hint">「ラベル | URL」の形。URL は https:// で始めてください</p></div>`;
  } else {
    fields = html`<div class="field"><label>本文</label>${ta("body", s.body || "", "自由に書けます（改行もそのまま表示されます）", 6)}</div>`;
  }
  return html`<section class="card gd-ed t-${s.type}" data-idx="${i}">
    <div class="gd-ed-head">
      <span class="gd-ed-no num">${pad2(i + 1)}</span>
      <span class="gd-ed-type">${t.icon} ${t.label}</span>
      <div class="gd-ed-tools">
        <button type="button" class="icon-btn" data-move="-1" aria-label="上へ" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="icon-btn" data-move="1" aria-label="下へ" ${i === n - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="icon-btn gd-del" data-remove aria-label="このセクションを削除">🗑</button>
      </div>
    </div>
    <div class="gd-ed-row">
      <div class="field gd-ed-icon"><label>アイコン</label><input class="input" name="icon" maxlength="16" value="${s.icon || ""}" /></div>
      <div class="field grow"><label>見出し</label><input class="input" name="title" maxlength="40" value="${s.title || ""}" placeholder="${t.title}" /></div>
    </div>
    <div class="gd-icons" role="group" aria-label="アイコンを選ぶ">${ICONS.map((ic) => html`<button type="button" class="gd-icon-opt ${ic === s.icon ? "on" : ""}" data-icon="${ic}">${ic}</button>`)}</div>
    ${fields}
    <div class="field"><label>補足（任意）</label><textarea class="textarea gd-ta" name="note" rows="2" maxlength="1000" placeholder="例: 決まり次第お知らせします">${s.note || ""}</textarea></div>
  </section>`;
}

function editorHtml(draft, { exists }) {
  const n = draft.sections.length;
  return html`<form class="gd-edit form" novalidate>
    <section class="card gd-ed-cover">
      <p class="card-title"><span class="icon">📖</span>表紙</p>
      <div class="field"><label>タイトル</label><input class="input" name="g_title" maxlength="60" value="${draft.title}" placeholder="例: 白馬合宿のしおり" /></div>
      <div class="field"><label>サブタイトル</label><input class="input" name="g_subtitle" maxlength="80" value="${draft.subtitle}" placeholder="例: 2027.2.13 SAT – 2.14 SUN" /></div>
      <div class="field"><label>ひとこと</label><textarea class="textarea gd-ta" name="g_message" rows="2" maxlength="300" placeholder="例: 最高の2日間にしよう！">${draft.message}</textarea></div>
    </section>
    <p class="section-title">セクション<span class="dim">${n}件・タップで開く順に並びます</span></p>
    <div class="stack" data-sections>${draft.sections.map((s, i) => sectionEditor(s, i, n))}</div>
    <section class="card gd-add">
      <p class="card-title"><span class="icon">＋</span>セクションを追加</p>
      <div class="gd-add-grid">${Object.entries(GUIDE_TYPES).map(([k, t]) => html`<button type="button" class="btn gd-add-btn" data-add="${k}" ${n >= 20 ? "disabled" : ""}><span>${t.icon}</span>${t.label}</button>`)}</div>
    </section>
    ${exists ? html`<button type="button" class="btn btn-ghost btn-block sch-danger" data-act="delete-guide">🗑 しおりを削除</button>` : ""}
    <div class="savebar"><button type="submit" class="btn btn-primary btn-block">💾 しおりを保存</button></div>
  </form>`;
}

// フォーム → しおりデータ（links の不正な行は bad に入る）
function collect(form, draft) {
  const val = (root, name) => root.querySelector(`[name="${name}"]`)?.value ?? "";
  const bad = [];
  const sections = [...form.querySelectorAll("[data-idx]")].map((card) => {
    const old = draft.sections[Number(card.dataset.idx)];
    const s = { id: old.id, type: old.type, title: val(card, "title").trim(), icon: val(card, "icon").trim(), note: val(card, "note").trim() };
    if (s.type === "timeline") s.days = textToTimeline(val(card, "timeline"));
    else if (s.type === "stay") for (const k of ["name", "address", "url", "mapUrl", "checkin", "checkout"]) s[k] = val(card, k).trim();
    else if (s.type === "checklist") s.items = val(card, "items").split("\n").map((x) => x.trim()).filter(Boolean);
    else if (s.type === "rooms") s.rooms = textToRooms(val(card, "rooms"));
    else if (s.type === "links") {
      const r = textToLinks(val(card, "links"));
      s.links = r.links;
      if (r.bad.length) bad.push(`「${s.title || "リンク"}」の${r.bad.join("・")}行目`);
    } else s.body = val(card, "body").trim();
    return s;
  });
  return {
    guide: { title: val(form, "g_title").trim(), subtitle: val(form, "g_subtitle").trim(), message: val(form, "g_message").trim(), sections },
    bad,
  };
}

export async function renderGuideEdit(view, { params }) {
  setHeader({ title: "しおりを編集", back: `/schedule/${params.id}` });
  if (!isAdmin()) {
    mount(view, empty("しおりの編集は管理者だけができます", { icon: "🔒", action: html`<a class="btn" href="#/schedule/${params.id}/guide">しおりを見る</a>` }));
    return;
  }
  const id = encodeURIComponent(params.id);
  const [d, g] = await Promise.all([get(`/events/${id}`), get(`/events/${id}/guide`)]);
  const e = d.event;
  const exists = !!g.guide;
  let draft = exists ? structuredClone(g.guide) : guideTemplate(e);
  let mode = "edit";
  setHeader({ title: exists ? "しおりを編集" : "しおりを作る", back: `/schedule/${e.id}` });

  const shell = html`<div class="gd-ed-top">
      <p class="gd-ed-event">${e.title}<span class="dim">${exists ? "" : " ・ テンプレートから作成"}</span></p>
      <div class="segmented gd-mode" role="tablist">
        <button type="button" role="tab" class="active" data-mode="edit" aria-selected="true">✏️ 編集</button>
        <button type="button" role="tab" data-mode="preview" aria-selected="false">👀 プレビュー</button>
      </div>
    </div>
    <div data-editor></div>
    <div data-preview data-gd-eid="${e.id}" hidden></div>`;
  mount(view, shell);
  const editor = view.querySelector("[data-editor]");
  const preview = view.querySelector("[data-preview]");
  const drawEditor = () => mount(editor, editorHtml(draft, { exists }));
  const sync = () => {
    const form = editor.querySelector("form");
    if (form) draft = { ...draft, ...collect(form, draft).guide };
  };
  drawEditor();

  const setMode = (m) => {
    if (m === mode) return;
    if (m === "preview") {
      sync();
      mount(preview, fullGuideHtml(e.id, draft, { preview: true }));
    }
    mode = m;
    editor.hidden = m !== "edit";
    preview.hidden = m !== "preview";
    for (const b of view.querySelectorAll("[data-mode]")) {
      b.classList.toggle("active", b.dataset.mode === m);
      b.setAttribute("aria-selected", String(b.dataset.mode === m));
    }
    window.scrollTo({ top: 0 });
  };

  const offs = [
    bindGuide(preview),
    on(view, "click", "[data-mode]", (_, b) => setMode(b.dataset.mode)),
    on(editor, "click", "[data-add]", (_, b) => {
      sync();
      if (draft.sections.length >= 20) return toast("セクションは20個までです");
      draft.sections.push(newSection(b.dataset.add, e));
      drawEditor();
      const cards = editor.querySelectorAll("[data-idx]");
      cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast(`「${typeInfo(b.dataset.add).title}」を追加しました`);
    }),
    on(editor, "click", "[data-move]", (_, b) => {
      sync();
      const i = Number(b.closest("[data-idx]").dataset.idx);
      const j = i + Number(b.dataset.move);
      if (j < 0 || j >= draft.sections.length) return;
      [draft.sections[i], draft.sections[j]] = [draft.sections[j], draft.sections[i]];
      drawEditor();
      editor.querySelectorAll("[data-idx]")[j]?.scrollIntoView({ block: "center" });
    }),
    on(editor, "click", "[data-remove]", async (_, b) => {
      const i = Number(b.closest("[data-idx]").dataset.idx);
      sync();
      const s = draft.sections[i];
      if (!(await confirmDialog(`「${s.title || typeInfo(s.type).title}」を削除しますか？`, { ok: "削除する", danger: true }))) return;
      draft.sections.splice(i, 1);
      drawEditor();
    }),
    on(editor, "click", "[data-icon]", (_, b) => {
      const card = b.closest("[data-idx]");
      card.querySelector("[name=icon]").value = b.dataset.icon;
      for (const x of card.querySelectorAll("[data-icon]")) x.classList.toggle("on", x === b);
    }),
    on(editor, "click", "[data-act=delete-guide]", async (_, b) => {
      if (!(await confirmDialog("しおりを削除しますか？元に戻せません。", { ok: "削除する", danger: true }))) return;
      busy(b, async () => {
        await del(`/events/${e.id}/guide`);
        toast("しおりを削除しました");
        navigate(`/schedule/${e.id}`, { replace: true });
      });
    }),
    on(editor, "submit", "form", (ev, form) => {
      ev.preventDefault();
      busy(form.querySelector("[type=submit]"), async () => {
        const { guide, bad } = collect(form, draft);
        if (bad.length) throw new Error(`リンクのURLは https:// で始めてください（${bad.join("、")}）`);
        if (!guide.title && !guide.sections.length) throw new Error("タイトルかセクションを入れてください");
        await put(`/events/${e.id}/guide`, { guide });
        resetGuideOpen(e.id, { root: true });
        toast("しおりを保存しました 📖", { type: "success" });
        navigate(`/schedule/${e.id}`);
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}
