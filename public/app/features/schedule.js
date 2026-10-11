// 日程: 予定一覧・カレンダー・詳細と出欠・予定の作成編集・球場・日程調整・カレンダー連携
import { $, appUrl, del, get, html, isAdmin, mount, navigate, on, patch, post, put, raw, setHeader, shareToLine, state } from "../core.js";
import {
  avatar,
  busy,
  celebrate,
  confirmDialog,
  daysFrom,
  empty,
  fmtDate,
  mapUrl,
  multiline,
  readForm,
  segmented,
  sheet,
  toast,
  todayStr,
  weekday,
  weekdayClass,
} from "../ui.js";

// ---------------------------------------------------------------- 定数・小物
const TYPES = {
  game: { label: "試合", chip: "chip-green", icon: "⚾" },
  practice: { label: "練習", chip: "chip-blue", icon: "🏃" },
  other: { label: "その他", chip: "chip-purple", icon: "📌" },
};
const RSVP = {
  yes: { label: "出席", mark: "○", cls: "yes" },
  maybe: { label: "未定", mark: "△", cls: "maybe" },
  no: { label: "欠席", mark: "×", cls: "no" },
};
const NEED = 9; // 試合に必要な人数

const typeOf = (t) => TYPES[t] || TYPES.other;
const hm = (t) => (t ? t.replace(/^0(\d)/, "$1") : "");
const pad = (n) => String(n).padStart(2, "0");
const addDays = (d, n) => {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const suggestTitle = (type, opponent) =>
  type === "game" ? (opponent ? `vs ${opponent}` : "試合") : type === "practice" ? "練習" : "予定";

const typeChip = (t) => html`<span class="chip ${typeOf(t).chip}">${typeOf(t).icon} ${typeOf(t).label}</span>`;

function datebox(d) {
  const [, m, day] = d.split("-").map(Number);
  return html`<div class="datebox sch-datebox"><p class="datebox-m">${m}月</p><p class="datebox-d">${day}</p><p class="datebox-w ${weekdayClass(d)}">${weekday(d)}</p></div>`;
}

// "今日！" "明日" "あと3日" "3日前"
function countdown(date, today) {
  const n = daysFrom(date, today);
  if (n === 0) return { big: "今日！", unit: "", label: "今日！", n };
  if (n === 1) return { big: "明日", unit: "", label: "明日", n };
  if (n > 0) return { pre: "あと", big: String(n), unit: "日", label: `あと${n}日`, n };
  return { big: String(-n), unit: "日前", label: `${-n}日前`, n };
}

function countdownHtml(cd) {
  if (!cd.unit) return html`<span class="sch-cd-word">${cd.big}</span>`;
  return html`${cd.pre ? html`<span class="sch-cd-unit">${cd.pre}</span>` : ""}<span class="num sch-cd-num" data-count="${cd.big}">${cd.big}</span><span class="sch-cd-unit">${cd.unit}</span>`;
}

// 数字のカウントアップ
function countUp(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const el of root.querySelectorAll("[data-count]")) {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to) || to <= 0) continue;
    const start = performance.now();
    const dur = Math.min(900, 300 + to * 40);
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = "0";
    requestAnimationFrame(step);
  }
}

function headerAction(selector, fn) {
  return on($("#page-actions"), "click", selector, fn);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("コピーしました", { type: "success" });
}

// Googleカレンダーの予定作成URL
function gcalUrl(e) {
  const start = e.meet_time || e.start_time;
  let dates;
  if (start) {
    const s = `${e.date.replace(/-/g, "")}T${start.replace(":", "")}00`;
    let endDate = e.date;
    let end = e.end_time && e.end_time > start ? e.end_time : null;
    if (!end) {
      const [h, m] = start.split(":").map(Number);
      const total = h * 60 + m + 180;
      if (total >= 1440) endDate = addDays(e.date, 1);
      end = `${pad(Math.floor((total % 1440) / 60))}:${pad(total % 60)}`;
    }
    dates = `${s}/${endDate.replace(/-/g, "")}T${end.replace(":", "")}00`;
  } else {
    dates = `${e.date.replace(/-/g, "")}/${addDays(e.date, 1).replace(/-/g, "")}`;
  }
  const details = [
    e.meet_time && `集合: ${hm(e.meet_time)}${e.meet_place ? `（${e.meet_place}）` : ""}`,
    e.start_time && `開始: ${hm(e.start_time)}`,
    e.opponent && `対戦相手: ${e.opponent}`,
    e.belongings && `持ち物: ${e.belongings}`,
    e.note,
    `出欠: ${appUrl(`/schedule/${e.id}`)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, ctz: "Asia/Tokyo", details });
  if (e.venue) q.set("location", e.venue);
  return `https://calendar.google.com/calendar/render?${q}`;
}

// LINE 共有用の Flex Message
function flexFor(e) {
  const row = (label, value) => ({
    type: "box",
    layout: "baseline",
    spacing: "md",
    contents: [
      { type: "text", text: label, size: "sm", color: "#8c96aa", flex: 2 },
      { type: "text", text: value, size: "sm", color: "#111111", wrap: true, flex: 6, weight: "bold" },
    ],
  });
  const rows = [row("日付", fmtDate(e.date, { year: true }))];
  if (e.meet_time) rows.push(row("集合", `${hm(e.meet_time)}${e.meet_place ? ` ${e.meet_place}` : ""}`));
  if (e.start_time) rows.push(row("開始", hm(e.start_time) + (e.end_time ? `〜${hm(e.end_time)}` : "")));
  if (e.venue) rows.push(row("球場", e.venue));
  if (e.opponent) rows.push(row("相手", e.opponent));
  if (e.belongings) rows.push(row("持ち物", e.belongings));
  const t = typeOf(e.type);
  return {
    type: "flex",
    altText: `【${t.label}】${fmtDate(e.date)} ${e.title}${e.meet_time ? ` 集合${hm(e.meet_time)}` : ""}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `${t.icon} ${t.label}${e.status === "canceled" ? "（中止）" : ""}`, size: "xs", color: e.status === "canceled" ? "#ff5a5f" : "#128a52", weight: "bold" },
          { type: "text", text: e.title, size: "xl", weight: "bold", wrap: true },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "sm", contents: rows },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "button", style: "primary", color: "#06c755", action: { type: "uri", label: "出欠を回答する", uri: appUrl(`/schedule/${e.id}`) } },
        ],
      },
    },
  };
}

async function shareEvent(e) {
  try {
    const ok = await shareToLine([flexFor(e)]);
    if (ok) toast("LINEに送りました", { type: "success" });
    else if (state.mock) toast("この環境ではLINE共有は使えません（LINEアプリで開くと使えます）");
    else toast("LINEで開くと共有できます");
  } catch (err) {
    toast(err.message || "共有できませんでした", { type: "error" });
  }
}

const mapLink = (e, venue) => e.venue_url || venue?.url || (e.venue ? mapUrl(venue?.address || e.venue) : "");

// ---------------------------------------------------------------- 予定フォーム
let venuesCache = null;
async function loadVenues() {
  if (!venuesCache) venuesCache = (await get("/venues")).venues;
  return venuesCache;
}

async function openEventForm(e = null, { onSaved } = {}) {
  const venues = await loadVenues().catch(() => []);
  const isNew = !e;
  const v = e || { type: "game", date: addDays(todayStr(), 7) };
  const val = (k) => v[k] ?? "";
  sheet({
    title: isNew ? "予定を追加" : "予定を編集",
    body: html`<form class="form sch-form" novalidate>
      ${isNew ? html`<button type="button" class="btn btn-ghost btn-sm sch-copy" data-act="copy-last">📋 前回の予定をコピー</button>` : ""}
      <div class="field">
        <span class="field-label">種類</span>
        <div class="sch-type-pick">
          ${Object.entries(TYPES).map(
            ([k, t]) => html`<label class="sch-type-opt ${k}"><input type="radio" name="type" value="${k}" ${v.type === k ? "checked" : ""} /><span>${t.icon} ${t.label}</span></label>`,
          )}
        </div>
      </div>
      <div class="field"><label for="sf-opp">対戦相手</label><input id="sf-opp" class="input" name="opponent" maxlength="60" value="${val("opponent")}" placeholder="例: 北町タイガース" /></div>
      <div class="field"><label for="sf-title">タイトル</label><input id="sf-title" class="input" name="title" maxlength="60" value="${val("title")}" placeholder="${suggestTitle(v.type, v.opponent)}" /><p class="hint">空欄なら「${suggestTitle(v.type, v.opponent)}」のように自動で付きます</p></div>
      <div class="field"><label for="sf-date">日付</label><input id="sf-date" class="input" type="date" name="date" required value="${val("date")}" /></div>
      <div class="grid-3">
        <div class="field"><label for="sf-meet">集合</label><input id="sf-meet" class="input sch-time" type="time" name="meet_time" value="${val("meet_time")}" /></div>
        <div class="field"><label for="sf-start">開始</label><input id="sf-start" class="input sch-time" type="time" name="start_time" value="${val("start_time")}" /></div>
        <div class="field"><label for="sf-end">終了</label><input id="sf-end" class="input sch-time" type="time" name="end_time" value="${val("end_time")}" /></div>
      </div>
      <div class="field"><label for="sf-mp">集合場所</label><input id="sf-mp" class="input" name="meet_place" maxlength="100" value="${val("meet_place")}" placeholder="例: 球場の駐車場" /></div>
      <div class="field">
        <label for="sf-venue">球場</label>
        ${venues.length
          ? html`<select class="select" data-act="pick-venue" aria-label="球場マスタから選ぶ">
              <option value="">🏟 登録済みの球場から選ぶ…</option>
              ${venues.map((x) => html`<option value="${x.id}" ${x.name === v.venue ? "selected" : ""}>${x.name}</option>`)}
            </select>`
          : ""}
        <input id="sf-venue" class="input" name="venue" maxlength="100" value="${val("venue")}" placeholder="球場名を入力" />
      </div>
      <div class="field"><label for="sf-url">地図URL</label><input id="sf-url" class="input" type="url" name="venue_url" value="${val("venue_url")}" placeholder="https://maps.app.goo.gl/…（空なら球場名で検索）" /></div>
      <div class="field"><label for="sf-bel">持ち物</label><textarea id="sf-bel" class="textarea sch-short" name="belongings" maxlength="500" placeholder="例: ユニフォーム上下・スパイク・水筒">${val("belongings")}</textarea></div>
      <div class="field"><label for="sf-note">メモ</label><textarea id="sf-note" class="textarea sch-short" name="note" maxlength="2000" placeholder="雨天時の連絡、駐車場など">${val("note")}</textarea></div>
      <div class="field"><label for="sf-dl">出欠締切</label><input id="sf-dl" class="input" type="date" name="rsvp_deadline" value="${val("rsvp_deadline")}" /></div>
      <button class="btn btn-primary btn-block" type="submit">${isNew ? "予定を追加する" : "保存する"}</button>
    </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      const f = (n) => form.elements[n];
      let lastSuggest = suggestTitle(v.type, v.opponent);
      const refreshSuggest = () => {
        const type = form.querySelector("input[name=type]:checked")?.value || "game";
        const s = suggestTitle(type, f("opponent").value.trim());
        f("title").placeholder = s;
        if (f("title").value === lastSuggest) f("title").value = "";
        lastSuggest = s;
        el.querySelector(".sch-form .hint").textContent = `空欄なら「${s}」のように自動で付きます`;
      };
      form.addEventListener("input", (ev) => {
        if (ev.target.name === "opponent" || ev.target.name === "type") refreshSuggest();
      });
      form.addEventListener("change", (ev) => {
        if (ev.target.name === "type") refreshSuggest();
        if (ev.target.dataset.act === "pick-venue") {
          const x = venues.find((x) => String(x.id) === ev.target.value);
          if (x) {
            f("venue").value = x.name;
            f("venue_url").value = x.url || "";
          }
        }
      });
      form.querySelector("[data-act=copy-last]")?.addEventListener("click", (ev) =>
        busy(ev.currentTarget, async () => {
          const type = form.querySelector("input[name=type]:checked")?.value || "game";
          let { event: last } = await get(`/events/latest?type=${type}`);
          if (!last) ({ event: last } = await get("/events/latest"));
          if (!last) return toast("コピーできる予定がまだありません");
          for (const k of ["meet_time", "start_time", "end_time", "meet_place", "venue", "venue_url", "opponent", "belongings", "note"]) {
            f(k).value = last[k] || "";
          }
          form.querySelector(`input[name=type][value=${last.type}]`).checked = true;
          f("title").value = last.title === suggestTitle(last.type, last.opponent) ? "" : last.title;
          refreshSuggest();
          const sel = form.querySelector("[data-act=pick-venue]");
          if (sel) sel.value = venues.find((x) => x.name === last.venue)?.id ?? "";
          toast(`「${last.title}」(${fmtDate(last.date)}) の内容をコピーしました`, { type: "success" });
        }),
      );
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const body = readForm(form);
          if (!body.date) throw new Error("日付を入力してください");
          const res = isNew ? await post("/events", body) : await patch(`/events/${e.id}`, body);
          close();
          toast(isNew ? "予定を追加しました！" : "保存しました", { type: "success" });
          onSaved?.(res.event);
        });
      });
    },
  });
}

// ---------------------------------------------------------------- 予定一覧
function eventRow(e, today) {
  const canceled = e.status === "canceled";
  const n = daysFrom(e.date, today);
  const my = e.my_status ? RSVP[e.my_status] : null;
  const sub = [
    e.opponent && e.type === "game" && !e.title.includes(e.opponent) ? `vs ${e.opponent}` : "",
    e.meet_time ? `集合 ${hm(e.meet_time)}` : e.start_time ? `${hm(e.start_time)}〜` : "",
    e.venue || "",
  ].filter(Boolean);
  return html`<a class="list-item sch-item ${canceled ? "is-canceled" : ""} t-${e.type}" href="#/schedule/${e.id}">
    ${datebox(e.date)}
    <div class="list-main">
      <div class="sch-chips">
        ${typeChip(e.type)}
        ${canceled ? html`<span class="chip chip-red">中止</span>` : ""}
        ${!canceled && n >= 0 && n <= 7 ? html`<span class="chip chip-amber">${countdown(e.date, today).label}</span>` : ""}
      </div>
      <p class="list-title sch-title">${e.title}</p>
      ${sub.length ? html`<p class="list-sub ellipsis">${sub.join(" ・ ")}</p>` : ""}
    </div>
    <div class="sch-side">
      ${canceled
        ? ""
        : my
          ? html`<span class="sch-mark ${my.cls}" title="${my.label}">${my.mark}</span>`
          : n >= 0
            ? html`<span class="sch-mark none">未</span>`
            : ""}
      <span class="sch-yes"><b class="num">${e.counts.yes}</b>人</span>
    </div>
  </a>`;
}

function groupByMonth(events) {
  const groups = [];
  for (const e of events) {
    const key = e.date.slice(0, 7);
    if (groups.at(-1)?.key !== key) groups.push({ key, items: [] });
    groups.at(-1).items.push(e);
  }
  return groups;
}

const monthLabel = (key) => `${Number(key.slice(0, 4))}年${Number(key.slice(5))}月`;

async function renderList(view, { query }) {
  const mode = ["upcoming", "past", "cal"].includes(query.view) ? query.view : "upcoming";
  const admin = isAdmin();
  setHeader({
    title: "日程",
    actions: admin ? html`<button class="btn btn-sm btn-primary" data-act="new-event">＋予定</button>` : "",
  });
  const openNew = () => openEventForm(null, { onSaved: (ev) => navigate(`/schedule/${ev.id}`) });

  const pendingP = get("/events/pending").catch(() => null);
  let body;
  if (mode === "cal") {
    const month = /^\d{4}-\d{2}$/.test(query.month || "") ? query.month : todayStr().slice(0, 7);
    const data = await get(`/events?range=month&month=${month}`);
    body = calendarView(data, query.day);
  } else {
    const data = await get(`/events?range=${mode}`);
    const groups = groupByMonth(data.events);
    body = data.events.length
      ? groups.map(
          (g) => html`<p class="section-title">${monthLabel(g.key)}<span class="dim">${g.items.length}件</span></p>
            <div class="list">${g.items.map((e) => eventRow(e, data.today))}</div>`,
        )
      : mode === "upcoming"
        ? empty(html`これからの予定はまだありません。<br />次の試合、決めちゃいましょう！`, {
            icon: "📅",
            action: admin
              ? html`<button class="btn btn-primary" data-act="new-event">＋ 予定を追加</button>`
              : html`<a class="btn" href="#/polls">🗳 日程調整を見る</a>`,
          })
        : empty("過去の予定はまだありません", { icon: "📖" });
  }
  const pend = await pendingP;
  const pollBadge = pend?.polls?.length || 0;
  mount(
    view,
    html`${segmented("sv", [["upcoming", "これから"], ["past", "過去"], ["cal", "カレンダー"]], mode)}
      <nav class="sch-shortcuts">
        <a class="sch-sc" href="#/polls">🗳 日程調整${pollBadge ? html`<span class="badge">${pollBadge}</span>` : ""}</a>
        <a class="sch-sc" href="#/schedule/venues">🏟 球場</a>
        <a class="sch-sc" href="#/calendar">🔗 カレンダー連携</a>
      </nav>
      ${body}`,
  );

  const offs = [
    on(view, "click", "[data-segmented=sv] button", (_, b) => navigate(b.dataset.value === "upcoming" ? "/schedule" : `/schedule?view=${b.dataset.value}`, { replace: true })),
    on(view, "click", "[data-act=new-event]", openNew),
    on(view, "click", "[data-month]", (_, b) => navigate(`/schedule?view=cal&month=${b.dataset.month}`, { replace: true })),
    on(view, "click", "[data-day]", (_, b) => {
      for (const c of view.querySelectorAll("[data-day]")) c.classList.toggle("selected", c === b);
      const box = view.querySelector("[data-day-list]");
      box.dataset.dayList = b.dataset.day;
      for (const it of box.querySelectorAll("[data-date]")) it.hidden = it.dataset.date !== b.dataset.day;
      const any = box.querySelector(`[data-date="${b.dataset.day}"]`);
      box.querySelector("[data-day-empty]").hidden = !!any;
      box.querySelector("[data-day-title]").textContent = fmtDate(b.dataset.day);
    }),
    headerAction("[data-act=new-event]", openNew),
  ];
  if (query.new === "1" && admin) openNew();
  return () => offs.forEach((f) => f());
}

function calendarView({ events, month, today }, day) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  let selected = day && day.startsWith(month) ? day : today.startsWith(month) ? today : events[0]?.date || `${month}-01`;
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(html`<span class="sch-cell blank"></span>`);
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${pad(d)}`;
    const list = byDay.get(date) || [];
    cells.push(html`<button type="button" class="sch-cell ${weekdayClass(date)} ${date === today ? "today" : ""} ${date === selected ? "selected" : ""} ${list.length ? "has" : ""} ${date < today ? "past" : ""}" data-day="${date}" aria-label="${fmtDate(date)} ${list.length}件">
      <span class="sch-cell-d num">${d}</span>
      <span class="sch-dots">${list.slice(0, 3).map((e) => html`<i class="t-${e.type} ${e.status === "canceled" ? "x" : ""}"></i>`)}</span>
    </button>`);
  }
  const sel = byDay.get(selected) || [];
  return html`<div class="card sch-cal">
      <div class="sch-cal-head">
        <button type="button" class="icon-btn" data-month="${prev}" aria-label="前の月">‹</button>
        <p class="sch-cal-title"><span class="num">${y}</span>年 <span class="num sch-cal-m">${m}</span>月</p>
        <button type="button" class="icon-btn" data-month="${next}" aria-label="次の月">›</button>
      </div>
      <div class="sch-grid sch-week">${["日", "月", "火", "水", "木", "金", "土"].map((w, i) => html`<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`)}</div>
      <div class="sch-grid">${cells}</div>
      <div class="sch-legend"><span><i class="t-game"></i>試合</span><span><i class="t-practice"></i>練習</span><span><i class="t-other"></i>その他</span><span class="dim">この月 ${events.length}件</span></div>
    </div>
    <div data-day-list="${selected}" class="stack">
      <p class="section-title" data-day-title>${fmtDate(selected)}</p>
      <div class="list">
        ${events.map((e) => html`<div data-date="${e.date}" ${e.date === selected ? "" : "hidden"}>${eventRow(e, today)}</div>`)}
      </div>
      <p class="sch-day-empty muted small center" data-day-empty ${sel.length ? "hidden" : ""}>この日の予定はありません ⚾</p>
    </div>`;
}

// ---------------------------------------------------------------- 予定詳細
function personChip(a, admin) {
  const m = a.member || a;
  return html`<button type="button" class="sch-person ${a.status || "none"}" ${admin ? html`data-proxy="${m.id}"` : "disabled"}>
    ${avatar(m, "sm")}<span class="sch-person-name">${m.name}</span>${m.isGuest ? html`<span class="sch-guest">助</span>` : ""}
  </button>`;
}

function attendanceBlock(d, admin) {
  const e = d.event;
  const groups = { yes: [], maybe: [], no: [] };
  for (const a of d.attendance) groups[a.status]?.push(a);
  const total = d.attendance.length + d.unanswered.length;
  const yes = e.counts.yes;
  const isGame = e.type === "game";
  const comments = d.attendance.filter((a) => a.comment);
  return html`<section class="card sch-att">
    <div class="card-head">
      <p class="card-title"><span class="icon">👥</span>みんなの出欠</p>
      <span class="card-sub"><b class="num sch-big-n">${d.attendance.length}</b> / ${total}人 回答</span>
    </div>
    ${isGame && e.status !== "canceled"
      ? html`<div class="sch-nine ${yes >= NEED ? "ok" : ""}">
          <div class="sch-nine-dots">${Array.from({ length: NEED }, (_, i) => html`<i class="${i < yes ? "on" : ""}" style="--i:${i}"></i>`)}</div>
          <p class="sch-nine-msg">${yes >= NEED ? html`⚾ ${NEED}人そろった！${yes > NEED ? html` <span class="muted small">（控え${yes - NEED}人）</span>` : ""}` : html`あと<b class="num">${NEED - yes}</b>人で${NEED}人`}</p>
        </div>`
      : ""}
    <div class="tiles cols-4 sch-tiles">
      <div class="tile yes"><p class="tile-label">出席</p><p class="tile-value" data-count="${yes}">${yes}</p></div>
      <div class="tile maybe"><p class="tile-label">未定</p><p class="tile-value" data-count="${e.counts.maybe}">${e.counts.maybe}</p></div>
      <div class="tile no"><p class="tile-label">欠席</p><p class="tile-value" data-count="${e.counts.no}">${e.counts.no}</p></div>
      <div class="tile none"><p class="tile-label">未回答</p><p class="tile-value" data-count="${d.unanswered.length}">${d.unanswered.length}</p></div>
    </div>
    ${["yes", "maybe", "no"].map((k) =>
      groups[k].length
        ? html`<div class="sch-group"><p class="sch-group-title ${k}">${RSVP[k].mark} ${RSVP[k].label} <span class="num">${groups[k].length}</span></p>
            <div class="sch-people">${groups[k].map((a) => personChip({ ...a }, admin))}</div></div>`
        : "",
    )}
    ${d.unanswered.length
      ? html`<div class="sch-group"><p class="sch-group-title none">… 未回答 <span class="num">${d.unanswered.length}</span></p>
          <div class="sch-people">${d.unanswered.map((m) => personChip({ member: m, status: null }, admin))}</div></div>`
      : ""}
    ${comments.length
      ? html`<div class="sch-comments">${comments.map(
          (a) => html`<div class="sch-comment">${avatar(a.member, "xs")}<span class="sch-comment-name">${a.member.name}</span><span class="sch-mark sm ${RSVP[a.status].cls}">${RSVP[a.status].mark}</span><p>${a.comment}</p></div>`,
        )}</div>`
      : ""}
    ${admin ? html`<button type="button" class="btn btn-ghost btn-sm btn-block" data-act="proxy-all">✍️ 代理で入力（助っ人・LINE未回答の人）</button>` : ""}
  </section>`;
}

function rsvpButtons(current, { compact = false, attr = "data-rsvp" } = {}) {
  return html`<div class="sch-rsvp ${compact ? "compact" : ""}">
    ${Object.entries(RSVP).map(
      ([k, r]) => html`<button type="button" class="sch-rsvp-btn ${r.cls} ${current === k ? "active" : ""}" ${raw(attr)}="${k}" aria-pressed="${current === k}">
        <span class="sch-rsvp-mark">${r.mark}</span><span class="sch-rsvp-label">${r.label}</span>
      </button>`,
    )}
  </div>`;
}

function detailHtml(d, admin) {
  const e = d.event;
  const canceled = e.status === "canceled";
  const cd = countdown(e.date, d.today);
  const past = cd.n < 0;
  const deadlinePassed = e.rsvp_deadline && e.rsvp_deadline < d.today;
  const map = mapLink(e, d.venue);
  const times = [
    ["集合", e.meet_time, "meet"],
    ["開始", e.start_time, ""],
    ["終了", e.end_time, ""],
  ].filter(([, t]) => t);
  return html`<section class="card card-hero sch-hero t-${e.type} ${canceled ? "is-canceled" : ""}">
      <div class="row gap wrap">${typeChip(e.type)}${canceled ? html`<span class="chip chip-red">中止</span>` : ""}${d.game_id ? html`<span class="chip chip-amber">結果あり</span>` : ""}</div>
      <div class="sch-hero-top">
        <div class="sch-hero-main">
          <h2 class="sch-hero-title">${e.title}</h2>
          <p class="sch-hero-date"><span class="num">${fmtDate(e.date, { year: true })}</span></p>
        </div>
        ${canceled ? "" : html`<div class="sch-cd ${cd.n === 0 ? "today" : ""} ${past ? "past" : ""}">${countdownHtml(cd)}</div>`}
      </div>
      ${times.length
        ? html`<div class="sch-times">
            ${times.map(
              ([label, t, cls]) => html`<div class="sch-time-box ${cls}"><p class="sch-time-label">${label}</p><p class="num sch-time-val">${hm(t)}</p></div>`,
            )}
          </div>`
        : html`<p class="muted small">時間は未定です</p>`}
    </section>

    <section class="list sch-info">
      ${e.meet_place ? html`<div class="list-item"><span class="sch-ic">📍</span><div class="list-main"><p class="list-sub">集合場所</p><p class="list-title">${e.meet_place}</p></div></div>` : ""}
      ${e.venue
        ? html`<div class="list-item"><span class="sch-ic">🏟</span><div class="list-main"><p class="list-sub">球場</p><p class="list-title">${e.venue}</p>
            ${d.venue?.address ? html`<p class="list-sub">${d.venue.address}</p>` : ""}
            ${d.venue?.note ? html`<p class="sch-venue-note">🅿 ${multiline(d.venue.note)}</p>` : ""}</div>
            <a class="btn btn-sm" href="${map}" target="_blank" rel="noopener">🗺 地図</a></div>`
        : ""}
      ${e.opponent ? html`<div class="list-item"><span class="sch-ic">⚔️</span><div class="list-main"><p class="list-sub">対戦相手</p><p class="list-title">${e.opponent}</p></div></div>` : ""}
      ${e.belongings ? html`<div class="list-item"><span class="sch-ic">🎒</span><div class="list-main"><p class="list-sub">持ち物</p><p class="sch-text">${multiline(e.belongings)}</p></div></div>` : ""}
      ${e.note ? html`<div class="list-item"><span class="sch-ic">📝</span><div class="list-main"><p class="list-sub">メモ</p><p class="sch-text">${multiline(e.note)}</p></div></div>` : ""}
      ${!e.meet_place && !e.venue && !e.opponent && !e.belongings && !e.note ? html`<div class="list-item"><span class="sch-ic">📝</span><p class="muted small">詳細はまだ入っていません</p></div>` : ""}
    </section>

    ${canceled
      ? html`<section class="card sch-canceled-card"><p>🌧 この予定は<strong>中止</strong>になりました</p></section>`
      : html`<section class="card sch-my">
          <div class="card-head">
            <p class="card-title"><span class="icon">🙋</span>あなたの出欠</p>
            ${e.rsvp_deadline
              ? html`<span class="chip ${deadlinePassed ? "chip-red" : "chip-amber"}">${deadlinePassed ? "締切を過ぎました" : `締切 ${fmtDate(e.rsvp_deadline)}`}</span>`
              : ""}
          </div>
          ${past && !admin
            ? html`<p class="muted small">終わった予定です。${d.my ? `あなたは「${RSVP[d.my.status].label}」でした` : ""}</p>`
            : html`${rsvpButtons(d.my?.status)}
              <form class="sch-comment-form" data-act="comment">
                <input class="input" name="comment" maxlength="100" value="${d.my?.comment || ""}" placeholder="ひとこと（例: 10分遅れます）" aria-label="ひとことコメント" />
                <button class="btn btn-sm" type="submit">送信</button>
              </form>
              ${deadlinePassed ? html`<p class="hint">締切後の変更は、管理者にもひとこと伝えてください</p>` : ""}`}
        </section>`}

    ${attendanceBlock(d, admin)}

    <section class="stack">
      ${d.game_id ? html`<a class="btn btn-amber btn-block" href="#/games/${d.game_id}">📊 試合結果を見る</a>` : ""}
      <button type="button" class="btn btn-line btn-block" data-act="share">LINEで共有する</button>
      <a class="btn btn-block" href="${gcalUrl(e)}" target="_blank" rel="noopener">📆 Googleカレンダーに追加</a>
    </section>

    ${admin
      ? html`<section class="sch-admin">
          <p class="section-title">管理者メニュー</p>
          <div class="grid-3">
            <button type="button" class="btn" data-act="edit">✏️ 編集</button>
            ${canceled
              ? html`<button type="button" class="btn" data-act="restore">↩︎ 中止を取消</button>`
              : html`<button type="button" class="btn" data-act="cancel">🌧 中止</button>`}
            <button type="button" class="btn sch-danger" data-act="delete">🗑 削除</button>
          </div>
        </section>`
      : ""}`;
}

function proxySheet(d, member, apply) {
  const cur = d.attendance.find((a) => a.member.id === member.id);
  sheet({
    title: `${member.name} さんの出欠`,
    body: html`<div class="stack">
      ${rsvpButtons(cur?.status, { attr: "data-p" })}
      <input class="input" name="comment" maxlength="100" value="${cur?.comment || ""}" placeholder="ひとこと（任意）" aria-label="コメント" />
      ${cur ? html`<button type="button" class="btn btn-ghost btn-sm" data-p="none">未回答に戻す</button>` : ""}
      <p class="hint">管理者として代理で登録します</p>
    </div>`,
    onMount(el, close) {
      on(el, "click", "[data-p]", (_, b) =>
        busy(b, async () => {
          const status = b.dataset.p === "none" ? null : b.dataset.p;
          await apply({ status, comment: el.querySelector("[name=comment]").value, member_id: member.id });
          close();
          toast(`${member.name} さんを${status ? RSVP[status].label : "未回答"}にしました`, { type: "success" });
        }),
      );
    },
  });
}

async function proxyAllSheet(d, apply) {
  const { members } = await get("/members");
  const status = new Map(d.attendance.map((a) => [a.member.id, a.status]));
  const s = sheet({
    title: "代理で入力",
    body: html`<p class="hint" style="margin-bottom:8px">名前をタップして出欠を登録します</p>
      <div class="list">
        ${members.map((m) => {
          const st = status.get(m.id);
          return html`<button type="button" class="list-item" data-mid="${m.id}">${avatar(m, "sm")}<span class="list-main list-title">${m.name}${m.isGuest ? html` <span class="chip chip-purple">助っ人</span>` : ""}</span>
            ${st ? html`<span class="sch-mark ${RSVP[st].cls}">${RSVP[st].mark}</span>` : html`<span class="sch-mark none">未</span>`}</button>`;
        })}
      </div>`,
    onMount(el) {
      on(el, "click", "[data-mid]", (_, b) => {
        const m = members.find((x) => x.id === Number(b.dataset.mid));
        s.close();
        proxySheet(d, m, apply);
      });
    },
  });
}

async function renderDetail(view, { params }) {
  const admin = isAdmin();
  setHeader({ title: "予定", back: "/schedule" });
  let d = await get(`/events/${encodeURIComponent(params.id)}`);
  const draw = (first = false) => {
    setHeader({ title: typeOf(d.event.type).label + "の予定", back: "/schedule" });
    mount(view, detailHtml(d, admin));
    if (first) countUp(view);
  };
  draw(true);

  const apply = async (body) => {
    const before = d.event.counts.yes;
    d = await put(`/events/${d.event.id}/rsvp`, body);
    draw();
    const after = d.event.counts.yes;
    if (d.event.type === "game" && before < NEED && after >= NEED) {
      celebrate();
      toast(`⚾ ${NEED}人そろった！試合ができます！`, { type: "success", ms: 3500 });
      return true;
    }
    return false;
  };

  const offs = [
    on(view, "click", "[data-rsvp]", (_, b) =>
      busy(b, async () => {
        const status = b.dataset.rsvp;
        const comment = view.querySelector(".sch-comment-form [name=comment]")?.value ?? "";
        const big = await apply({ status, comment });
        if (!big) {
          if (status === "yes") toast("出席で登録しました！ナイス 💪", { type: "success" });
          else if (status === "maybe") toast("未定で登録しました。決まったら更新してね");
          else toast("欠席で登録しました。また次回！");
        }
        navigator.vibrate?.(10);
      }),
    ),
    on(view, "submit", "[data-act=comment]", (ev, form) => {
      ev.preventDefault();
      if (!d.my) return toast("先に 出席 / 未定 / 欠席 を選んでください");
      busy(form.querySelector("button"), async () => {
        await apply({ status: d.my.status, comment: form.elements.comment.value });
        toast("コメントを送りました", { type: "success" });
      });
    }),
    on(view, "click", "[data-proxy]", (_, b) => {
      const id = Number(b.dataset.proxy);
      const m = d.attendance.find((a) => a.member.id === id)?.member || d.unanswered.find((x) => x.id === id);
      if (m) proxySheet(d, m, apply);
    }),
    on(view, "click", "[data-act=proxy-all]", (_, b) => busy(b, () => proxyAllSheet(d, apply))),
    on(view, "click", "[data-act=share]", () => shareEvent(d.event)),
    on(view, "click", "[data-act=edit]", (_, b) =>
      busy(b, () =>
        openEventForm(d.event, {
          onSaved: async () => {
            d = await get(`/events/${d.event.id}`);
            draw();
          },
        }),
      ),
    ),
    on(view, "click", "[data-act=cancel]", async (_, b) => {
      if (!(await confirmDialog(`「${d.event.title}」を中止にしますか？\n出欠の記録は残ります。`, { ok: "中止にする", danger: true }))) return;
      busy(b, async () => {
        await post(`/events/${d.event.id}/cancel`);
        d = await get(`/events/${d.event.id}`);
        draw();
        toast("中止にしました");
      });
    }),
    on(view, "click", "[data-act=restore]", (_, b) =>
      busy(b, async () => {
        await post(`/events/${d.event.id}/restore`);
        d = await get(`/events/${d.event.id}`);
        draw();
        toast("中止を取り消しました", { type: "success" });
      }),
    ),
    on(view, "click", "[data-act=delete]", async (_, b) => {
      if (!(await confirmDialog(`「${d.event.title}」を削除しますか？\n出欠の記録も消え、元に戻せません。`, { ok: "削除する", danger: true }))) return;
      busy(b, async () => {
        await del(`/events/${d.event.id}`);
        toast("削除しました");
        navigate("/schedule", { replace: true });
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 球場
function venueForm(x, { onSaved }) {
  sheet({
    title: x ? "球場を編集" : "球場を登録",
    body: html`<form class="form">
      <div class="field"><label for="vf-name">球場名</label><input id="vf-name" class="input" name="name" maxlength="100" required value="${x?.name || ""}" placeholder="例: 市民球場 第2グラウンド" /></div>
      <div class="field"><label for="vf-addr">住所</label><input id="vf-addr" class="input" name="address" maxlength="200" value="${x?.address || ""}" /></div>
      <div class="field"><label for="vf-url">地図URL</label><input id="vf-url" class="input" type="url" name="url" value="${x?.url || ""}" placeholder="Googleマップの共有URL（空なら住所・名前で検索）" /></div>
      <div class="field"><label for="vf-note">メモ（駐車場・更衣室など）</label><textarea id="vf-note" class="textarea sch-short" name="note" maxlength="1000">${x?.note || ""}</textarea></div>
      <button class="btn btn-primary btn-block" type="submit">保存する</button>
      ${x ? html`<button class="btn btn-ghost btn-block sch-danger" type="button" data-act="del-venue">この球場を削除</button>` : ""}
    </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const body = readForm(form);
          if (x) await patch(`/venues/${x.id}`, body);
          else await post("/venues", body);
          venuesCache = null;
          close();
          toast("保存しました", { type: "success" });
          onSaved();
        });
      });
      form.querySelector("[data-act=del-venue]")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        if (!(await confirmDialog(`「${x.name}」を削除しますか？（予定に入っている球場名はそのまま残ります）`, { ok: "削除する", danger: true }))) return;
        busy(btn, async () => {
          await del(`/venues/${x.id}`);
          venuesCache = null;
          close();
          toast("削除しました");
          onSaved();
        });
      });
    },
  });
}

async function renderVenues(view) {
  const admin = isAdmin();
  setHeader({ title: "球場一覧", back: "/schedule", actions: admin ? html`<button class="btn btn-sm btn-primary" data-act="new-venue">＋球場</button>` : "" });
  const draw = async () => {
    const { venues } = await get("/venues");
    venuesCache = venues;
    mount(
      view,
      venues.length
        ? html`<p class="section-title">${venues.length}か所</p>
          <div class="stack">
            ${venues.map(
              (x) => html`<div class="card sch-venue">
                <div class="row gap">
                  <span class="sch-venue-ic">🏟</span>
                  <div class="grow">
                    <p class="strong">${x.name}</p>
                    ${x.address ? html`<p class="small muted">${x.address}</p>` : ""}
                  </div>
                  ${admin ? html`<button class="icon-btn" data-edit="${x.id}" aria-label="${x.name}を編集">✏️</button>` : ""}
                </div>
                ${x.note ? html`<p class="sch-venue-note">🅿 ${multiline(x.note)}</p>` : ""}
                <a class="btn btn-sm btn-block" href="${x.url || mapUrl(x.address || x.name)}" target="_blank" rel="noopener">🗺 地図で見る</a>
              </div>`,
            )}
          </div>`
        : empty("よく使う球場を登録しておくと、予定を作るときにワンタップで選べます", {
            icon: "🏟",
            action: admin ? html`<button class="btn btn-primary" data-act="new-venue">＋ 球場を登録</button>` : "",
          }),
    );
    return venues;
  };
  let venues = await draw();
  const refresh = async () => (venues = await draw());
  const offs = [
    on(view, "click", "[data-act=new-venue]", () => venueForm(null, { onSaved: refresh })),
    headerAction("[data-act=new-venue]", () => venueForm(null, { onSaved: refresh })),
    on(view, "click", "[data-edit]", (_, b) => venueForm(venues.find((x) => x.id === Number(b.dataset.edit)), { onSaved: refresh })),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 日程調整
function nextWeekend(from) {
  let d = from;
  for (let i = 0; i < 8; i++) {
    d = addDays(d, 1);
    const w = new Date(d + "T00:00:00").getDay();
    if (w === 6 || w === 0) return d;
  }
  return d;
}

function optionRow(o = {}) {
  return html`<div class="sch-opt-row" data-opt>
    <input class="input" type="date" name="o_date" value="${o.date || ""}" aria-label="候補日" required />
    <input class="input sch-time" type="time" name="o_time" value="${o.time || ""}" aria-label="時間（任意）" />
    <button type="button" class="icon-btn" data-act="rm-opt" aria-label="この候補を消す">✕</button>
    <input class="input sch-opt-note" name="o_note" maxlength="100" value="${o.note || ""}" placeholder="球場など（任意）" aria-label="メモ" />
  </div>`;
}

function pollForm({ onSaved }) {
  const d1 = nextWeekend(todayStr());
  const d2 = nextWeekend(d1);
  sheet({
    title: "日程調整をつくる",
    body: html`<form class="form sch-form" novalidate>
      <div class="field"><label for="pf-title">タイトル</label><input id="pf-title" class="input" name="title" maxlength="60" required placeholder="例: 11月の練習試合" /></div>
      <div class="field">
        <span class="field-label">候補日（時間・球場は任意）</span>
        <div class="stack" data-opts>${optionRow({ date: d1 })}${optionRow({ date: d2 })}</div>
        <div class="row gap">
          <button type="button" class="btn btn-sm grow" data-act="add-opt">＋ 候補を追加</button>
          <button type="button" class="btn btn-sm grow" data-act="add-weekend">📅 次の土日を追加</button>
        </div>
      </div>
      <div class="field"><label for="pf-dl">回答の締切</label><input id="pf-dl" class="input" type="date" name="deadline" /></div>
      <div class="field"><label for="pf-note">メモ</label><textarea id="pf-note" class="textarea sch-short" name="note" maxlength="1000" placeholder="対戦相手の候補、集合の目安など"></textarea></div>
      <button class="btn btn-primary btn-block" type="submit">🗳 この内容でつくる</button>
    </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      const box = form.querySelector("[data-opts]");
      const lastDate = () => [...box.querySelectorAll("[name=o_date]")].map((i) => i.value).filter(Boolean).sort().at(-1) || todayStr();
      const add = (o) => {
        box.insertAdjacentHTML("beforeend", String(optionRow(o)));
        box.lastElementChild.querySelector("input").focus({ preventScroll: true });
      };
      on(form, "click", "[data-act=add-opt]", () => add({ date: addDays(lastDate(), 7) }));
      on(form, "click", "[data-act=add-weekend]", () => {
        const sat = nextWeekend(lastDate());
        add({ date: sat });
        const w = new Date(sat + "T00:00:00").getDay();
        if (w === 6) add({ date: addDays(sat, 1) });
      });
      on(form, "click", "[data-act=rm-opt]", (_, b) => {
        if (box.children.length <= 1) return toast("候補は1つ以上必要です");
        b.closest("[data-opt]").remove();
      });
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const options = [...box.querySelectorAll("[data-opt]")].map((r) => ({
            date: r.querySelector("[name=o_date]").value,
            time: r.querySelector("[name=o_time]").value,
            note: r.querySelector("[name=o_note]").value,
          }));
          const f = form.elements;
          const res = await post("/polls", { title: f.title.value, deadline: f.deadline.value, note: f.note.value, options });
          close();
          toast("日程調整をつくりました！みんなに知らせましょう", { type: "success" });
          onSaved(res.poll);
        });
      });
    },
  });
}

async function renderPolls(view) {
  const admin = isAdmin();
  setHeader({ title: "日程調整", back: "/schedule", actions: admin ? html`<button class="btn btn-sm btn-primary" data-act="new-poll">＋つくる</button>` : "" });
  const { polls, member_count, today } = await get("/polls");
  const status = (p) =>
    p.status === "decided"
      ? html`<span class="chip chip-blue">🎉 決定</span>`
      : p.status === "closed" || (p.deadline && p.deadline < today)
        ? html`<span class="chip">締切</span>`
        : html`<span class="chip chip-green">受付中</span>`;
  const open = (p) => p.status === "open" && !(p.deadline && p.deadline < today);
  mount(
    view,
    polls.length
      ? html`<div class="stack">
          ${polls.map((p) => {
            const pct = member_count ? Math.min(100, Math.round((p.answer_count / member_count) * 100)) : 0;
            return html`<a class="card card-link sch-poll ${open(p) ? "" : "is-done"}" href="#/polls/${p.id}">
              <div class="row gap">
                ${status(p)}
                ${open(p) && !p.answered ? html`<span class="badge sch-unans">未回答</span>` : ""}
                <span class="spacer"></span>
                ${p.deadline ? html`<span class="small muted">締切 ${fmtDate(p.deadline)}</span>` : ""}
              </div>
              <p class="sch-poll-title">${p.title}</p>
              <p class="small muted">候補 ${p.option_count}日${p.first_date ? ` ・ ${fmtDate(p.first_date)}${p.last_date !== p.first_date ? `〜${fmtDate(p.last_date)}` : ""}` : ""}</p>
              <div class="sch-bar"><i style="width:${pct}%"></i></div>
              <p class="small muted">回答 <b class="num sch-poll-n">${p.answer_count}</b> / ${member_count}人</p>
            </a>`;
          })}
        </div>`
      : empty("日程調整はまだありません。候補日を出して、みんなの都合を一発で集めましょう！", {
          icon: "🗳",
          action: admin ? html`<button class="btn btn-primary" data-act="new-poll">＋ 日程調整をつくる</button>` : "",
        }),
  );
  const create = () => pollForm({ onSaved: (p) => navigate(`/polls/${p.id}`) });
  const offs = [on(view, "click", "[data-act=new-poll]", create), headerAction("[data-act=new-poll]", create)];
  return () => offs.forEach((f) => f());
}

const optLabel = (o) => html`<span class="num">${fmtDate(o.date)}</span>${o.time ? html` <span class="num">${hm(o.time)}</span>` : ""}`;
const ANS = { yes: "○", maybe: "△", no: "×" };

function pollDetailHtml(d, admin) {
  const { poll, options, answers, unanswered, best, my, today } = d;
  const isOpen = poll.status === "open";
  const late = poll.deadline && poll.deadline < today;
  const canAnswer = isOpen && (!late || admin);
  const max = Math.max(1, answers.length + unanswered.length);
  const decided = options.find((o) => o.id === poll.decided_option_id);
  return html`<section class="card sch-poll-head ${poll.status}">
      <div class="row gap wrap">
        ${poll.status === "decided" ? html`<span class="chip chip-blue">🎉 決定</span>` : isOpen && !late ? html`<span class="chip chip-green">受付中</span>` : html`<span class="chip">締切</span>`}
        ${poll.deadline ? html`<span class="chip ${late ? "" : "chip-amber"}">締切 ${fmtDate(poll.deadline)}</span>` : ""}
      </div>
      <h2 class="sch-poll-h">${poll.title}</h2>
      ${poll.note ? html`<p class="sch-text muted">${multiline(poll.note)}</p>` : ""}
      <p class="small muted">回答 <b class="num sch-big-n" data-count="${answers.length}">${answers.length}</b> / ${answers.length + unanswered.length}人</p>
    </section>

    ${decided
      ? html`<a class="card card-hero card-link sch-decided" href="#/schedule/${poll.event_id}">
          <p class="sch-decided-label">🎉 日程が決まりました！</p>
          <p class="sch-decided-date">${optLabel(decided)}</p>
          <p class="small">予定を見て出欠を回答する ›</p>
        </a>`
      : ""}

    <p class="section-title">候補日ごとの集計 ${best.length ? html`<span class="amber">👑 = 最有力</span>` : ""}</p>
    <div class="stack">
      ${options.map((o) => {
        const isBest = best.includes(o.id);
        return html`<div class="card card-flat sch-opt ${isBest ? "best" : ""} ${o.id === poll.decided_option_id ? "decided" : ""}">
          <div class="row gap">
            <div class="grow">
              <p class="sch-opt-date ${weekdayClass(o.date)}">${isBest ? "👑 " : ""}${optLabel(o)}</p>
              ${o.note ? html`<p class="small muted">🏟 ${o.note}</p>` : ""}
            </div>
            <div class="sch-opt-counts"><span class="yes">○<b class="num" data-count="${o.counts.yes}">${o.counts.yes}</b></span><span class="maybe">△<b class="num">${o.counts.maybe}</b></span><span class="no">×<b class="num">${o.counts.no}</b></span></div>
          </div>
          <div class="sch-bar stacked"><i class="yes" style="width:${(o.counts.yes / max) * 100}%"></i><i class="maybe" style="width:${(o.counts.maybe / max) * 100}%"></i></div>
          ${admin && isOpen ? html`<button type="button" class="btn btn-sm ${isBest ? "btn-amber" : ""} sch-decide" data-decide="${o.id}">この日に決定</button>` : ""}
        </div>`;
      })}
    </div>

    ${canAnswer
      ? html`<p class="section-title">あなたの都合</p>
        <form class="card sch-answer" data-act="answer">
          ${options.map(
            (o) => html`<div class="sch-ans-row">
              <p class="sch-ans-date ${weekdayClass(o.date)}">${optLabel(o)}</p>
              <div class="sch-ans-btns" role="radiogroup" aria-label="${fmtDate(o.date)}">
                ${["yes", "maybe", "no"].map(
                  (k) => html`<label class="sch-ans ${k}"><input type="radio" name="o${o.id}" value="${k}" ${my?.answers?.[o.id] === k ? "checked" : ""} /><span>${ANS[k]}</span></label>`,
                )}
              </div>
            </div>`,
          )}
          <input class="input" name="comment" maxlength="100" value="${my?.comment || ""}" placeholder="ひとこと（例: 午前なら行けます）" aria-label="コメント" />
          <button class="btn btn-primary btn-block" type="submit">${my ? "回答を更新する" : "回答する"}</button>
        </form>`
      : ""}

    <p class="section-title">みんなの回答</p>
    ${answers.length
      ? html`<div class="table-wrap sch-poll-table">
          <table class="table">
            <thead><tr><th>メンバー</th>${options.map((o) => html`<th class="${best.includes(o.id) ? "best" : ""}">${fmtDate(o.date)}${o.time ? html`<br />${hm(o.time)}` : ""}</th>`)}</tr></thead>
            <tbody>
              ${answers.map(
                (a) => html`<tr><td><span class="row gap sch-td-name">${avatar(a.member, "xs")}${a.member.name}</span></td>${options.map((o) => {
                  const v = a.answers[o.id];
                  return html`<td class="sch-cellans ${v || ""} ${best.includes(o.id) ? "best" : ""}">${v ? ANS[v] : "－"}</td>`;
                })}</tr>`,
              )}
              <tr class="total"><td>○ の数</td>${options.map((o) => html`<td class="${best.includes(o.id) ? "best" : ""}">${o.counts.yes}</td>`)}</tr>
            </tbody>
          </table>
        </div>
        ${answers.some((a) => a.comment)
          ? html`<div class="sch-comments card card-flat">${answers
              .filter((a) => a.comment)
              .map((a) => html`<div class="sch-comment">${avatar(a.member, "xs")}<span class="sch-comment-name">${a.member.name}</span><p>${a.comment}</p></div>`)}</div>`
          : ""}`
      : empty("まだだれも回答していません。一番乗りしよう！", { icon: "🏃" })}
    ${unanswered.length
      ? html`<div class="sch-group"><p class="sch-group-title none">未回答 <span class="num">${unanswered.length}</span></p>
          <div class="sch-people">${unanswered.map((m) => html`<span class="sch-person none">${avatar(m, "sm")}<span class="sch-person-name">${m.name}</span></span>`)}</div></div>`
      : ""}

    ${admin
      ? html`<section class="sch-admin"><p class="section-title">管理者メニュー</p>
          <div class="grid-2">
            ${poll.status === "open"
              ? html`<button type="button" class="btn" data-act="close-poll">🔒 締め切る</button>`
              : poll.status === "closed"
                ? html`<button type="button" class="btn" data-act="reopen-poll">🔓 受付を再開</button>`
                : html`<span></span>`}
            <button type="button" class="btn sch-danger" data-act="del-poll">🗑 削除</button>
          </div></section>`
      : ""}`;
}

function decideSheet(d, option, { onDone }) {
  const p = d.poll;
  sheet({
    title: "この日に決定",
    body: html`<form class="form sch-form">
      <div class="sch-decide-date"><p class="muted small">決定する日</p><p class="sch-decided-date">${optLabel(option)}</p></div>
      <div class="field">
        <span class="field-label">種類</span>
        <div class="sch-type-pick">
          ${Object.entries(TYPES).map(
            ([k, t]) => html`<label class="sch-type-opt ${k}"><input type="radio" name="type" value="${k}" ${k === "game" ? "checked" : ""} /><span>${t.icon} ${t.label}</span></label>`,
          )}
        </div>
      </div>
      <div class="field"><label for="df-title">タイトル</label><input id="df-title" class="input" name="title" maxlength="60" value="${p.title}" /></div>
      <div class="field"><label for="df-opp">対戦相手</label><input id="df-opp" class="input" name="opponent" maxlength="60" /></div>
      <div class="grid-2">
        <div class="field"><label for="df-meet">集合</label><input id="df-meet" class="input sch-time" type="time" name="meet_time" /></div>
        <div class="field"><label for="df-start">開始</label><input id="df-start" class="input sch-time" type="time" name="start_time" value="${option.time || ""}" /></div>
      </div>
      <div class="field"><label for="df-venue">球場</label><input id="df-venue" class="input" name="venue" maxlength="100" value="${option.note || ""}" /></div>
      <p class="hint">予定が作られ、日程調整は締め切られます。細かい内容はあとから編集できます。</p>
      <button class="btn btn-primary btn-block" type="submit">🎉 決定して予定をつくる</button>
    </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const res = await post(`/polls/${p.id}/decide`, { option_id: option.id, event: readForm(form) });
          close();
          celebrate();
          toast(`${fmtDate(option.date)} に決定しました！`, { type: "success", ms: 3500 });
          onDone(res);
        });
      });
    },
  });
}

async function renderPoll(view, { params }) {
  const admin = isAdmin();
  setHeader({ title: "日程調整", back: "/polls" });
  let d = await get(`/polls/${encodeURIComponent(params.id)}`);
  const draw = (first = false) => {
    mount(view, pollDetailHtml(d, admin));
    if (first) countUp(view);
  };
  draw(true);
  const offs = [
    on(view, "submit", "[data-act=answer]", (ev, form) => {
      ev.preventDefault();
      const answers = {};
      for (const o of d.options) {
        const v = form.querySelector(`input[name=o${o.id}]:checked`)?.value;
        if (v) answers[o.id] = v;
      }
      busy(form.querySelector("[type=submit]"), async () => {
        if (!Object.keys(answers).length) throw new Error("どれか1つは ○△× を選んでください");
        const first = !d.my;
        d = await put(`/polls/${d.poll.id}/answer`, { answers, comment: form.elements.comment.value });
        draw();
        toast(first ? "回答しました！ありがとう 🙌" : "回答を更新しました", { type: "success" });
      });
    }),
    on(view, "click", "[data-decide]", (_, b) => {
      const o = d.options.find((x) => x.id === Number(b.dataset.decide));
      decideSheet(d, o, { onDone: (res) => navigate(`/schedule/${res.event.id}`) });
    }),
    on(view, "click", "[data-act=close-poll]", (_, b) =>
      busy(b, async () => {
        d = await patch(`/polls/${d.poll.id}`, { status: "closed" });
        draw();
        toast("締め切りました");
      }),
    ),
    on(view, "click", "[data-act=reopen-poll]", (_, b) =>
      busy(b, async () => {
        d = await patch(`/polls/${d.poll.id}`, { status: "open" });
        draw();
        toast("受付を再開しました", { type: "success" });
      }),
    ),
    on(view, "click", "[data-act=del-poll]", async (_, b) => {
      if (!(await confirmDialog(`「${d.poll.title}」を削除しますか？回答もすべて消えます。`, { ok: "削除する", danger: true }))) return;
      busy(b, async () => {
        await del(`/polls/${d.poll.id}`);
        toast("削除しました");
        navigate("/polls", { replace: true });
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- カレンダー連携
async function renderCalendar(view) {
  setHeader({ title: "カレンダー連携", back: "/more" });
  const { token } = await get("/settings/ics");
  const https = `${location.origin}/ics/${token}.ics`;
  const webcal = https.replace(/^https?:/, "webcal:");
  const gcal = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  mount(
    view,
    html`<section class="card card-hero sch-ical-hero">
        <p class="sch-ical-icon">📅</p>
        <h2 class="sch-ical-title">チームの予定を<br />いつものカレンダーに</h2>
        <p class="small">一度登録すれば、試合・練習の追加や変更、中止も自動で反映されます（反映まで数時間かかることがあります）。</p>
      </section>

      <section class="card stack">
        <p class="card-title"><span class="icon">🍎</span>iPhone（標準カレンダー）</p>
        <a class="btn btn-primary btn-block" href="${webcal}">iPhoneのカレンダーに追加</a>
        <ol class="sch-steps">
          <li>上のボタンを押して「照会」をタップ</li>
          <li>うまく開かないときは、下の URL をコピーして<br /><b>設定 → カレンダー → アカウント → アカウントを追加 → その他 → 照会するカレンダーを追加</b> に貼り付け</li>
        </ol>
        <div class="sch-url"><code>${webcal}</code><button type="button" class="btn btn-sm" data-copy="${webcal}">コピー</button></div>
      </section>

      <section class="card stack">
        <p class="card-title"><span class="icon">🟦</span>Googleカレンダー（Android・PC）</p>
        <a class="btn btn-block" href="${gcal}" target="_blank" rel="noopener">Googleカレンダーで開く</a>
        <ol class="sch-steps">
          <li>パソコンのブラウザで Googleカレンダーを開く（スマホアプリからは追加できません）</li>
          <li>左の「他のカレンダー」の <b>＋</b> → <b>URL で追加</b></li>
          <li>下の URL を貼り付けて「カレンダーを追加」。スマホのアプリにも自動で出てきます</li>
        </ol>
        <div class="sch-url"><code>${https}</code><button type="button" class="btn btn-sm" data-copy="${https}">コピー</button></div>
      </section>

      <p class="hint center">🔒 この URL を知っている人は誰でも予定を見られます。チームの外には共有しないでください。</p>`,
  );
  const off = on(view, "click", "[data-copy]", (_, b) => copyText(b.dataset.copy));
  return off;
}

// ---------------------------------------------------------------- ホームカード
function nextCardHtml(d) {
  const admin = isAdmin();
  if (!d.event) {
    return html`<section class="card card-hero sch-next empty-next">
      <div class="card-head"><p class="card-title"><span class="icon">📅</span>次の予定</p></div>
      <p class="sch-next-empty">次の予定はまだありません。<br />グラウンドが待ってるぞ！⚾</p>
      ${admin
        ? html`<div class="row gap"><a class="btn btn-primary grow" href="#/schedule?new=1">＋ 予定を追加</a><a class="btn grow" href="#/polls">🗳 日程調整</a></div>`
        : html`<a class="btn btn-block" href="#/polls">🗳 日程調整を見る</a>`}
    </section>`;
  }
  const e = d.event;
  const cd = countdown(e.date, d.today);
  const yesList = d.attendance.filter((a) => a.status === "yes");
  const map = mapLink(e, d.venue);
  const deadlinePassed = e.rsvp_deadline && e.rsvp_deadline < d.today;
  return html`<section class="card card-hero sch-next t-${e.type} ${cd.n === 0 ? "is-today" : ""}">
    <div class="card-head">
      <p class="card-title"><span class="icon">${typeOf(e.type).icon}</span>次の${typeOf(e.type).label}</p>
      ${e.rsvp_deadline && !d.my ? html`<span class="chip ${deadlinePassed ? "chip-red" : "chip-amber"}">締切 ${fmtDate(e.rsvp_deadline)}</span>` : typeChip(e.type)}
    </div>
    <a class="sch-next-main" href="#/schedule/${e.id}">
      <div class="sch-cd big ${cd.n === 0 ? "today" : ""}">${countdownHtml(cd)}</div>
      <div class="sch-next-body">
        <p class="sch-next-title">${e.title}</p>
        <p class="sch-next-date num">${fmtDate(e.date)}</p>
      </div>
      <span class="chev">›</span>
    </a>
    <div class="sch-next-info">
      ${e.meet_time
        ? html`<div><p class="sch-time-label">集合</p><p class="num sch-next-time">${hm(e.meet_time)}</p></div>`
        : e.start_time
          ? html`<div><p class="sch-time-label">開始</p><p class="num sch-next-time">${hm(e.start_time)}</p></div>`
          : ""}
      ${e.venue
        ? html`<a class="sch-next-venue" href="${map}" target="_blank" rel="noopener"><p class="sch-time-label">球場 🗺</p><p class="ellipsis">${e.venue}</p></a>`
        : ""}
    </div>
    ${rsvpButtons(d.my?.status, { compact: true, attr: "data-home-rsvp" })}
    <div class="sch-next-foot">
      <span class="avatars">${yesList.slice(0, 7).map((a) => avatar(a.member, "sm"))}</span>
      <span class="small">出席 <b class="num sch-next-n">${e.counts.yes}</b>人${e.type === "game" ? html`${e.counts.yes >= NEED ? html` <span class="green">・${NEED}人そろった！</span>` : html` <span class="muted">・あと${NEED - e.counts.yes}人で${NEED}人</span>`}` : ""}</span>
    </div>
  </section>`;
}

async function pendingCardHtml() {
  const p = await get("/events/pending");
  if (!p.count) return "";
  const items = [
    ...p.events.map((e) => ({ href: `#/schedule/${e.id}`, icon: typeOf(e.type).icon, title: e.title, sub: `${fmtDate(e.date)}${e.rsvp_deadline ? ` ・ 締切 ${fmtDate(e.rsvp_deadline)}` : ""}` })),
    ...p.polls.map((x) => ({ href: `#/polls/${x.id}`, icon: "🗳", title: x.title, sub: `日程調整${x.deadline ? ` ・ 締切 ${fmtDate(x.deadline)}` : ""}` })),
  ];
  return html`<section class="card sch-pending">
    <div class="card-head">
      <p class="card-title"><span class="icon">📮</span>未回答が <b class="num sch-pending-n">${p.count}</b> 件</p>
      <span class="card-sub">タップして回答</span>
    </div>
    <div class="list">
      ${items.slice(0, 4).map(
        (it) => html`<a class="list-item" href="${it.href}"><span class="sch-ic">${it.icon}</span><div class="list-main"><p class="list-title ellipsis">${it.title}</p><p class="list-sub">${it.sub}</p></div><span class="chev">›</span></a>`,
      )}
    </div>
    ${items.length > 4 ? html`<p class="small muted center" style="margin-top:8px">ほか ${items.length - 4} 件</p>` : ""}
  </section>`;
}

let homeNext = null;

// ---------------------------------------------------------------- 登録
export default {
  name: "schedule",
  routes: {
    "/schedule": renderList,
    "/schedule/venues": renderVenues,
    "/schedule/:id": renderDetail,
    "/polls": renderPolls,
    "/polls/:id": renderPoll,
    "/calendar": renderCalendar,
  },
  homeCards: [
    {
      order: 10,
      render: async () => {
        homeNext = await get("/events/next");
        return nextCardHtml(homeNext);
      },
      bind: (el) => {
        countUp(el);
        on(el, "click", "[data-home-rsvp]", (_, b) =>
          busy(b, async () => {
            const before = homeNext.event.counts.yes;
            const status = b.dataset.homeRsvp;
            homeNext = await put(`/events/${homeNext.event.id}/rsvp`, { status, comment: homeNext.my?.comment || "" });
            mount(el, nextCardHtml(homeNext));
            if (homeNext.event.type === "game" && before < NEED && homeNext.event.counts.yes >= NEED) {
              celebrate();
              toast(`⚾ ${NEED}人そろった！`, { type: "success" });
            } else toast(`${RSVP[status].label}で登録しました${status === "yes" ? "！ナイス 💪" : ""}`, { type: "success" });
            // 未回答カードも更新
            const slot = document.querySelector(".sch-pending")?.parentElement;
            if (slot) {
              const out = await pendingCardHtml().catch(() => "");
              if (String(out)) mount(slot, out);
              else slot.remove();
            }
          }),
        );
      },
    },
    { order: 12, render: pendingCardHtml, bind: (el) => countUp(el) },
  ],
  menu: [
    { path: "/polls", label: "日程調整", icon: "🗳", order: 10 },
    { path: "/schedule/venues", label: "球場一覧", icon: "🏟", order: 11 },
    { path: "/calendar", label: "カレンダー連携", icon: "📅", order: 12 },
  ],
};
