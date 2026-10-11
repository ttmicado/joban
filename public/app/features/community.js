// community 機能: チーム（お知らせ・起床報告・練習報告）
import { $, appUrl, del, esc, get, html, isAdmin, mount, navigate, on, patch, post, raw, setHeader, shareToLine, state } from "../core.js";
import {
  ago,
  avatar,
  busy,
  celebrate,
  confirmDialog,
  copyText,
  countUp,
  fab,
  empty,
  fmtDate,
  loading,
  memberLabel,
  readForm,
  relDay,
  sheet,
  toast,
  toastError,
  todayStr,
} from "../ui.js";

// ================================================================ 共通
const pad = (n) => String(n).padStart(2, "0");
const JST = 9 * 3600 * 1000;
// epoch ms → "6:05"（JST）
const hm = (ts) => {
  const d = new Date(ts + JST);
  return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`;
};
const minToHm = (min) => `${Math.floor(min / 60)}:${pad(Math.round(min % 60))}`;
const addDaysStr = (date, n) => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const fmtAmount = (n) => (Number.isInteger(n) ? n.toLocaleString("ja-JP") : String(n));

// テキストの URL を自動リンクにして改行を <br> に（http/https のみ・すべてエスケープ）
function linkify(text) {
  const parts = String(text || "").split(/(https?:\/\/[^\s<>"'`）」』、。]+)/g);
  return raw(
    parts
      .map((p, i) =>
        i % 2
          ? `<a href="${esc(p)}" target="_blank" rel="noopener noreferrer">${esc(p)}</a>`
          : esc(p).replace(/\n/g, "<br>"),
      )
      .join(""),
  );
}

const cnt = (n, cls = "") => html`<span class="num ${cls}" data-count="${n}">0</span>`;

const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, val) {
    try {
      localStorage.setItem(k, val);
    } catch {}
  },
};

// 大きな演出（「3番目の起床！」など）。タップか時間経過で消える
function splash({ icon = "", big = "", text = "", sub = "", tone = "amber" }) {
  const el = document.createElement("div");
  el.className = `cm-splash cm-splash-${tone}`;
  mount(
    el,
    html`<div class="cm-splash-inner">
      <div class="cm-splash-icon">${icon}</div>
      ${big ? html`<div class="cm-splash-big num">${big}</div>` : ""}
      <div class="cm-splash-text">${text}</div>
      ${sub ? html`<div class="cm-splash-sub">${sub}</div>` : ""}
    </div>`,
  );
  document.body.append(el);
  navigator.vibrate?.([20, 40, 20]);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener("click", close);
  setTimeout(close, 2200);
}

// ================================================================ お知らせ
const CATS = {
  info: { label: "連絡", chip: "chip-blue", icon: "📣" },
  important: { label: "重要", chip: "chip-red", icon: "⚠️" },
  chat: { label: "雑談", chip: "chip-purple", icon: "💬" },
};

const ackBar = (n) => {
  const pct = n.total ? Math.round((n.ackCount / n.total) * 100) : 0;
  return html`<div class="cm-ackbar ${pct === 100 ? "full" : ""}">
    <div class="cm-ackbar-track"><i style="width:${pct}%"></i></div>
    <span class="cm-ackbar-label">了解 <b class="num">${n.ackCount}</b> / ${n.total}人</span>
  </div>`;
};

const ackButton = (n, { size = "" } = {}) =>
  n.acked
    ? html`<button class="btn ${size} cm-acked" data-act="unack" data-id="${n.id}" aria-label="了解を取り消す">✓ 了解済み</button>`
    : html`<button class="btn btn-primary ${size} cm-ack-btn" data-act="ack" data-id="${n.id}">👍 了解！</button>`;

function noticeCard(n) {
  const cat = CATS[n.category] || CATS.info;
  const head = n.title || n.body.split("\n")[0];
  const preview = n.title ? n.body : n.body.split("\n").slice(1).join("\n");
  return html`<article class="card cm-notice cm-cat-${n.category} ${n.read ? "" : "unread"}">
    <a class="cm-notice-link" href="#/notices/${n.id}">
      <div class="row gap cm-notice-meta">
        <span class="chip ${cat.chip}">${cat.icon} ${cat.label}</span>
        ${n.pinned ? html`<span class="chip chip-amber">📌 ピン留め</span>` : ""}
        ${n.read ? "" : html`<span class="cm-new">NEW</span>`}
        <span class="spacer"></span>
        <span class="small muted">${ago(n.createdAt)}</span>
      </div>
      <h3 class="cm-notice-title">${head}</h3>
      ${preview ? html`<p class="cm-notice-preview">${preview}</p>` : ""}
    </a>
    <div class="row gap cm-notice-foot">
      ${avatar(n.author, "xs")}<span class="small muted grow ellipsis">${n.author?.name || "退団したメンバー"}</span>
      ${ackButton(n, { size: "btn-sm" })}
    </div>
    ${ackBar(n)}
  </article>`;
}

async function doAck(id, ack) {
  const res = ack ? await post(`/notices/${id}/ack`) : await del(`/notices/${id}/ack`);
  if (ack) {
    navigator.vibrate?.(15);
    if (res.notice.ackCount === res.notice.total) toast("全員が了解しました！🎉", { type: "success" });
  }
  return res.notice;
}

function noticeForm(n = {}) {
  const admin = isAdmin();
  const cats = Object.entries(CATS).filter(([k]) => admin || k !== "important" || n.category === "important");
  const cur = n.category || "info";
  return html`<form class="form cm-form">
    <div class="field"><span class="field-label">カテゴリ</span>
      <div class="pills">
        ${cats.map(
          ([k, c]) =>
            html`<label class="pill"><input type="radio" name="category" value="${k}" ${k === cur ? "checked" : ""} ${!admin && k === "important" ? "disabled" : ""} /><span>${c.icon} ${c.label}</span></label>`,
        )}
      </div>
    </div>
    <div class="field"><label>タイトル（任意）</label><input class="input" name="title" maxlength="60" value="${n.title || ""}" placeholder="例: 日曜の集合時間" /></div>
    <div class="field"><label>本文</label><textarea class="textarea" name="body" maxlength="2000" rows="6" required placeholder="みんなに伝えたいことを書こう">${n.body || ""}</textarea></div>
    ${admin
      ? html`<label class="pill"><input type="checkbox" name="pinned" ${n.pinned ? "checked" : ""} /><span>📌 一番上にピン留め</span></label>`
      : html`<p class="hint">「重要」とピン留めは管理者だけが使えます</p>`}
    <button class="btn btn-primary btn-block" type="submit">${n.id ? "保存する" : "投稿する"}</button>
  </form>`;
}

function openNoticeForm(n, onDone) {
  sheet({
    title: n ? "お知らせを編集" : "お知らせを投稿",
    body: noticeForm(n || {}),
    onMount(el, close) {
      const form = el.querySelector("form");
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const body = readForm(form);
          if (!isAdmin()) delete body.pinned;
          if (!body.category) delete body.category;
          const res = n ? await patch(`/notices/${n.id}`, body) : await post("/notices", body);
          close();
          toast(n ? "保存しました" : "投稿しました！", { type: "success" });
          onDone?.(res.notice);
        });
      });
      setTimeout(() => form.querySelector("textarea")?.focus(), 300);
    },
  });
}

async function noticesSection(box) {
  const draw = async () => {
    const { notices, unread } = await get("/notices");
    mount(
      box,
      html`${notices.length
          ? html`<p class="section-title"><span>お知らせ ${unread ? html`<span class="badge">${unread}</span>` : ""}</span><span class="small muted">ピン留め → 新しい順</span></p>
              <div class="stack">${notices.map(noticeCard)}</div>`
          : empty("まだお知らせはありません。最初の連絡を投稿してみよう！", { icon: "📭" })}
        ${fab({ label: "お知らせを投稿", short: "投稿", icon: "✏️", act: "compose" })}`,
    );
    return notices;
  };
  let notices = await draw();
  const offs = [
    on(box, "click", "[data-act=compose]", () => openNoticeForm(null, async () => (notices = await draw()))),
    on(box, "click", "[data-act=ack],[data-act=unack]", (e, b) => {
      e.preventDefault();
      busy(b, async () => {
        const n = await doAck(Number(b.dataset.id), b.dataset.act === "ack");
        const card = b.closest(".cm-notice");
        const tmp = document.createElement("div");
        mount(tmp, noticeCard(n));
        const fresh = tmp.firstElementChild;
        if (n.acked) fresh.querySelector(".cm-acked")?.classList.add("pop");
        card.replaceWith(fresh);
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

async function renderNotice(view, { params }) {
  setHeader({ title: "お知らせ", back: "/team?tab=notices" });
  const load = () => get(`/notices/${encodeURIComponent(params.id)}`);
  let data = await load();
  const draw = () => {
    const { notice: n, acked, notAcked, canEdit } = data;
    const cat = CATS[n.category] || CATS.info;
    setHeader({
      title: "お知らせ",
      back: "/team?tab=notices",
      actions: canEdit ? html`<button class="icon-btn" data-act="menu" aria-label="編集メニュー">⋯</button>` : "",
    });
    mount(
      view,
      html`<article class="card cm-notice-detail cm-cat-${n.category}">
          <div class="row gap wrap">
            <span class="chip ${cat.chip}">${cat.icon} ${cat.label}</span>
            ${n.pinned ? html`<span class="chip chip-amber">📌 ピン留め</span>` : ""}
          </div>
          ${n.title ? html`<h2 class="cm-detail-title">${n.title}</h2>` : ""}
          <div class="row gap cm-detail-author">
            ${avatar(n.author, "sm")}
            <div><p class="strong small">${n.author ? memberLabel(n.author) : "退団したメンバー"}</p>
              <p class="small muted">${fmtDate(new Date(n.createdAt + JST).toISOString().slice(0, 10))} ${hm(n.createdAt)}${n.edited ? "（編集済み）" : ""}</p></div>
          </div>
          <div class="cm-detail-body">${linkify(n.body)}</div>
        </article>

        <section class="card cm-ack-card">
          <div class="cm-ack-ring" style="--p:${n.total ? (n.ackCount / n.total) * 100 : 0}">
            <div><b class="num" data-count="${n.ackCount}">0</b><span class="small muted"> / ${n.total}人</span><p class="small muted">了解</p></div>
          </div>
          <div class="grow stack">
            ${n.acked
              ? html`<div class="cm-stamp">了解！</div><button class="btn btn-ghost btn-sm" data-act="unack" data-id="${n.id}">了解を取り消す</button>`
              : html`<button class="btn btn-primary btn-block cm-ack-big" data-act="ack" data-id="${n.id}">👍 了解！</button>
                  <p class="hint center">読んだら押してね。LINEで「了解です」と返す代わりです</p>`}
          </div>
        </section>

        <p class="section-title"><span>了解した人 ${acked.length}</span></p>
        ${acked.length
          ? html`<div class="cm-people">${acked.map((m) => html`<div class="cm-person">${avatar(m, "md")}<span class="ellipsis">${m.name}</span><span class="cm-person-sub">${hm(m.at)}</span></div>`)}</div>`
          : html`<p class="small muted">まだいません</p>`}
        <p class="section-title"><span>まだの人 ${notAcked.length}</span>
          ${isAdmin() && notAcked.length ? html`<button class="btn btn-sm btn-amber" data-act="remind">📢 催促する</button>` : ""}</p>
        ${notAcked.length
          ? html`<div class="cm-people">${notAcked.map((m) => html`<div class="cm-person ${m.read ? "" : "dim"}">${avatar(m, "md")}<span class="ellipsis">${m.name}</span><span class="cm-person-sub">${m.read ? "既読" : "未読"}</span></div>`)}</div>`
          : html`<p class="cm-allclear">🎉 全員が了解しました！</p>`}`,
    );
    countUp(view);
  };
  draw();

  const offs = [
    on(view, "click", "[data-act=ack],[data-act=unack]", (_, b) =>
      busy(b, async () => {
        const ack = b.dataset.act === "ack";
        await doAck(data.notice.id, ack);
        data = await load();
        draw();
        if (ack) {
          view.querySelector(".cm-stamp")?.classList.add("pop");
          if (data.notice.ackCount === data.notice.total) celebrate();
        }
      }),
    ),
    on(view, "click", "[data-act=remind]", (_, b) =>
      busy(b, async () => {
        const n = data.notice;
        const names = data.notAcked.map((m) => `${m.name}さん`).join("、");
        const text = `【了解おねがいします🙏】${n.title || n.body.slice(0, 30)}\nまだの人: ${names}\n${appUrl(`/notices/${n.id}`)}`;
        if (await shareToLine([{ type: "text", text }])) return toast("送信しました", { type: "success" });
        await copyText(text, { message: "催促メッセージをコピーしました。LINEに貼り付けてね" });
      }),
    ),
    on($("#page-actions"), "click", "[data-act=menu]", () => {
      const s = sheet({
        title: "このお知らせ",
        body: html`<div class="stack">
          <button class="btn btn-block" data-x="edit">✏️ 編集する</button>
          <button class="btn btn-block btn-danger" data-x="delete">🗑 削除する</button>
        </div>`,
        onMount(el, close) {
          el.querySelector("[data-x=edit]").onclick = () => {
            close();
            openNoticeForm(data.notice, async () => {
              data = await load();
              draw();
            });
          };
          el.querySelector("[data-x=delete]").onclick = async () => {
            close();
            if (!(await confirmDialog("このお知らせを削除しますか？", { ok: "削除", danger: true }))) return;
            try {
              await del(`/notices/${data.notice.id}`);
              toast("削除しました");
              navigate("/team?tab=notices", { replace: true });
            } catch (err) {
              toastError(err);
            }
          };
        },
      });
      return s;
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ================================================================ 起床報告
const STAGE = {
  arrived: { icon: "📍", label: "到着", cls: "arrived" },
  left: { icon: "🚃", label: "出発", cls: "left" },
  late: { icon: "⏰", label: "遅れ", cls: "late" },
  woke: { icon: "☀️", label: "起床", cls: "woke" },
  sleep: { icon: "💤", label: "まだ寝てる？", cls: "sleep" },
};
const stageOf = (w) => (!w ? "sleep" : w.arrivedAt ? "arrived" : w.lateMinutes ? "late" : w.leftAt ? "left" : "woke");
const STAGE_ORDER = ["arrived", "left", "late", "woke", "sleep"];

function countdown(meetAt, skew) {
  if (!meetAt) return "";
  const ms = meetAt - (Date.now() + skew);
  if (ms <= 0) return html`<span class="cm-cd-done">集合時間です！</span>`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return html`<span class="cm-cd-label">集合まで</span><span class="num cm-cd-time">${h ? `${h}:${pad(m)}` : m}:${pad(s % 60)}</span>`;
}

function personTile(p) {
  const st = stageOf(p.wakeup);
  const s = STAGE[st];
  const w = p.wakeup;
  const sub =
    st === "sleep" ? "まだ" : st === "late" ? `+${w.lateMinutes}分` : st === "arrived" ? hm(w.arrivedAt) : st === "left" ? hm(w.leftAt) : hm(w.at);
  return html`<div class="cm-wtile cm-st-${s.cls}" title="${p.member.name} ${s.label}">
    <div class="cm-wtile-av">${avatar(p.member, "md")}${w ? html`<span class="cm-rank num ${w.rank === 1 ? "first" : ""}">${w.rank}</span>` : ""}<span class="cm-stage-ico">${s.icon}</span></div>
    <span class="cm-wtile-name ellipsis">${p.member.name}</span>
    <span class="cm-wtile-sub">${sub}</span>
    ${w?.comment ? html`<span class="cm-wtile-cmt ellipsis">${w.comment}</span>` : ""}
  </div>`;
}

function wakeBoard(b, { skew }) {
  const me = b.me.wakeup;
  const st = stageOf(me);
  const e = b.event;
  const att = b.people.filter((p) => p.attendance === "yes");
  const others = b.people.filter((p) => p.attendance !== "yes" && p.wakeup);
  const sorted = (list) =>
    [...list].sort((x, y) => STAGE_ORDER.indexOf(stageOf(x.wakeup)) - STAGE_ORDER.indexOf(stageOf(y.wakeup)) || (x.wakeup?.rank ?? 99) - (y.wakeup?.rank ?? 99));
  const allUp = b.counts.attending > 0 && b.counts.wokeAttending === b.counts.attending;
  const pct = b.counts.attending ? Math.round((b.counts.wokeAttending / b.counts.attending) * 100) : 0;
  return html`<section class="card cm-wake-hero ${me ? "is-up" : ""}">
      <div class="cm-sunrise" aria-hidden="true"></div>
      <div class="row gap cm-wake-event">
        <span class="chip ${e.type === "game" ? "chip-amber" : "chip-green"}">${e.type === "game" ? "試合" : e.type === "practice" ? "練習" : "予定"}</span>
        <span class="strong ellipsis grow">${e.title}</span>
      </div>
      <p class="small muted">${b.isToday ? "今日" : relDay(e.date)} ${fmtDate(e.date)}
        ${e.meetTime ? html` ・ 集合 <b class="amber">${e.meetTime}</b>` : ""}${e.startTime ? html` ・ 開始 ${e.startTime}` : ""}${e.venue ? html` ・ ${e.venue}` : ""}</p>
      ${b.isToday && b.meetAt ? html`<div class="cm-countdown" data-cd>${countdown(b.meetAt, skew)}</div>` : ""}

      ${!b.open
        ? html`<p class="cm-closed">${b.isToday ? "この予定は中止になりました" : "起床報告は予定の当日にできます"}</p>`
        : !me
          ? html`<button class="cm-wake-btn" data-act="wake"><span class="cm-wake-sun">☀️</span><span class="cm-wake-label">起きた！</span><span class="cm-wake-hint">タップで起床報告</span></button>
              <input class="input cm-wake-cmt" name="wakeComment" maxlength="100" placeholder="ひとこと（任意）例: 今日は打つぞ！" />`
          : html`<div class="cm-myrank">
                <div class="cm-medal ${me.rank === 1 ? "gold" : me.rank <= 3 ? "silver" : ""}"><span class="num">${me.rank}</span></div>
                <div class="grow"><p class="cm-myrank-title">${me.rank}番目の起床！</p>
                  <p class="small muted">${hm(me.at)} に起床 ${me.leftAt ? html`・ ${hm(me.leftAt)} 出発` : ""} ${me.arrivedAt ? html`・ ${hm(me.arrivedAt)} 到着` : ""}</p>
                  ${me.lateMinutes ? html`<p class="small red">⏰ ${me.lateMinutes}分ほど遅れます${me.comment ? `（${me.comment}）` : ""}</p>` : ""}</div>
              </div>
              <div class="cm-stage-btns">
                <button class="btn ${me.leftAt ? "done" : "btn-primary"}" data-act="stage" data-stage="left" ${me.leftAt ? "disabled" : ""}>🚃 ${me.leftAt ? "出発済み" : "出発した"}</button>
                <button class="btn ${me.arrivedAt ? "done" : me.leftAt ? "btn-primary" : ""}" data-act="stage" data-stage="arrived" ${me.arrivedAt ? "disabled" : ""}>📍 ${me.arrivedAt ? "到着済み" : "到着した"}</button>
              </div>
              ${me.arrivedAt ? "" : html`<button class="btn btn-ghost btn-block cm-late-btn" data-act="late">⏰ 遅れます…</button>`}
              <button class="cm-undo" data-act="undo">押し間違えた？取り消す</button>`}
    </section>

    ${allUp ? html`<div class="cm-allup"><span>🎉</span> 全員起床！ <span>🎉</span><p class="small">今日もいい試合にしよう！</p></div>` : ""}

    <section class="card">
      <div class="card-head"><p class="card-title"><span class="icon">⏰</span>起床ボード</p>
        <span class="small muted">出席予定 ${b.counts.attending}人</span></div>
      <div class="cm-wake-progress"><i style="width:${pct}%"></i></div>
      <div class="cm-wake-counts">
        <div><b class="num amber" data-count="${b.counts.wokeAttending}">0</b><span>起床</span></div>
        <div><b class="num blue" data-count="${b.counts.left}">0</b><span>出発</span></div>
        <div><b class="num green" data-count="${b.counts.arrived}">0</b><span>到着</span></div>
        <div><b class="num dim" data-count="${Math.max(0, b.counts.attending - b.counts.wokeAttending)}">0</b><span>寝てる？</span></div>
      </div>
      ${att.length
        ? html`<div class="cm-wgrid">${sorted(att).map(personTile)}</div>`
        : html`<p class="small muted center cm-pad">出席予定の人がまだいません</p>`}
      ${others.length
        ? html`<p class="cm-sub-title">出席予定以外で起きた人</p><div class="cm-wgrid">${sorted(others).map(personTile)}</div>`
        : ""}
    </section>`;
}

function rankingCard(r, { full = false } = {}) {
  const list = full ? r.ranking : r.ranking.slice(0, 5);
  const medal = (i) => ["🥇", "🥈", "🥉"][i] || html`<span class="num">${i + 1}</span>`;
  return html`<section class="card">
    <div class="card-head"><p class="card-title"><span class="icon">🐓</span>起床ランキング ${r.season}</p>
      ${full ? "" : html`<a class="small" href="#/wakeup/ranking">すべて見る ›</a>`}</div>
    ${list.length
      ? html`<div class="cm-rank-list">
          ${list.map(
            (x, i) => html`<div class="cm-rank-row">
              <span class="cm-rank-pos">${medal(i)}</span>${avatar(x.member, "sm")}
              <span class="grow ellipsis strong">${x.member.name}</span>
              <span class="cm-rank-stat"><b class="num amber">${x.firsts}</b><small>一番乗り</small></span>
              <span class="cm-rank-stat"><b class="num">${x.avgBefore != null ? x.avgBefore : "-"}</b><small>分前（平均）</small></span>
              <span class="cm-rank-stat"><b class="num">${minToHm(x.avgTime)}</b><small>平均起床</small></span>
            </div>`,
          )}
        </div>`
      : html`<p class="small muted center cm-pad">まだ記録がありません。試合の朝に一番乗りを狙おう！</p>`}
  </section>`;
}

async function wakeSection(box, { eventId = null, header = null } = {}) {
  let timer = null;
  let tick = null;
  let skew = 0;
  let current = eventId ? Number(eventId) : null;
  let boards = [];

  const load = async () => {
    const [today, rank] = await Promise.all([get("/wakeups/today"), get("/wakeups/ranking")]);
    skew = today.now - Date.now();
    boards = today.events;
    let b = null;
    if (current) b = boards.find((x) => x.event.id === current) || (await get(`/wakeups/${current}`));
    else b = boards[0] || null;
    if (b) current = b.event.id;
    return { today, rank, b };
  };

  const draw = ({ today, rank, b }) => {
    header?.(b);
    const picker =
      today.events.length > 1
        ? html`<div class="pills cm-picker">${today.events.map(
            (x) => html`<button class="pill-btn ${x.event.id === current ? "active" : ""}" data-act="pick" data-id="${x.event.id}">${x.event.meetTime || x.event.startTime || ""} ${x.event.title}</button>`,
          )}</div>`
        : "";
    mount(
      box,
      html`${picker}
        ${b
          ? wakeBoard(b, { skew })
          : html`<section class="card cm-nowake">
              <p class="cm-nowake-icon">😴</p>
              <p class="strong">今日は予定がありません</p>
              <p class="small muted">試合や練習の日の朝、ここで「起きた！」を報告できます。<br />今日はぐっすり寝ても大丈夫！</p>
              ${state.mock && isAdmin() ? html`<button class="btn btn-sm" data-act="dev-event">🛠 開発用: 今日の予定を作る</button>` : ""}
            </section>`}
        ${rankingCard(rank)}`,
    );
    countUp(box);
    // 全員起床の演出（予定ごとに1回）
    if (b && b.counts.attending > 0 && b.counts.wokeAttending === b.counts.attending) {
      const key = `cm-allup-${b.event.id}`;
      if (!storage.get(key)) {
        storage.set(key, "1");
        celebrate();
      }
    }
  };

  const refresh = async () => draw(await load());
  await refresh();

  tick = setInterval(() => {
    const el = box.querySelector("[data-cd]");
    const b = boards.find((x) => x.event.id === current);
    if (el && b) mount(el, countdown(b.meetAt, skew));
  }, 1000);
  timer = setInterval(() => {
    if (document.visibilityState === "visible" && !document.querySelector(".sheet")) refresh().catch(() => {});
  }, 30000);

  const send = (btn, body) =>
    busy(btn, async () => {
      const comment = box.querySelector("[name=wakeComment]")?.value;
      const res = await post(`/wakeups/${current}`, { comment, ...body });
      if (res.created) {
        if (res.rank === 1) {
          celebrate();
          splash({ icon: "🥇", big: "1", text: "番乗りの起床！", sub: "今日のチームで一番早起き！" });
        } else splash({ icon: "☀️", big: String(res.rank), text: "番目の起床！", sub: `${res.counts.woke}人が起きてます` });
      } else if (body.stage === "left") toast("🚃 出発！気をつけて", { type: "success" });
      else if (body.stage === "arrived") {
        toast("📍 到着！おつかれさま", { type: "success" });
        if (res.counts.arrived === 1) splash({ icon: "📍", big: "1", text: "番乗りで到着！", tone: "green" });
      } else if (body.stage === "late") toast("遅れる連絡をしました");
      await refresh();
    });

  const offs = [
    on(box, "click", "[data-act=wake]", (_, b) => send(b, { stage: "woke" })),
    on(box, "click", "[data-act=stage]", (_, b) => send(b, { stage: b.dataset.stage })),
    on(box, "click", "[data-act=pick]", (_, b) => {
      current = Number(b.dataset.id);
      refresh().catch(toastError);
    }),
    on(box, "click", "[data-act=undo]", async () => {
      if (!(await confirmDialog("起床報告を取り消しますか？", { ok: "取り消す", danger: true }))) return;
      try {
        await del(`/wakeups/${current}`);
        await refresh();
      } catch (err) {
        toastError(err);
      }
    }),
    on(box, "click", "[data-act=dev-event]", (_, b) =>
      busy(b, async () => {
        await post("/wakeups/dev-event");
        await refresh();
      }),
    ),
    on(box, "click", "[data-act=late]", () => {
      sheet({
        title: "遅れます",
        body: html`<form class="form">
          <div class="field"><span class="field-label">どれくらい遅れそう？</span>
            <div class="pills">${[5, 10, 15, 20, 30, 45, 60].map(
              (m, i) => html`<label class="pill"><input type="radio" name="lateMinutes" value="${m}" ${i === 2 ? "checked" : ""} /><span>${m}分</span></label>`,
            )}</div></div>
          <div class="field"><label>ひとこと</label><input class="input" name="comment" maxlength="100" placeholder="例: 電車が遅れています🙏" /></div>
          <button class="btn btn-amber btn-block" type="submit">⏰ 遅れる連絡をする</button>
        </form>`,
        onMount(el, close) {
          const form = el.querySelector("form");
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            const f = readForm(form);
            busy(form.querySelector("[type=submit]"), async () => {
              await post(`/wakeups/${current}`, { stage: "late", lateMinutes: Number(f.lateMinutes), comment: f.comment });
              close();
              toast("遅れる連絡をしました。焦らず安全に！");
              await refresh();
            });
          });
        },
      });
    }),
  ];
  return () => {
    clearInterval(timer);
    clearInterval(tick);
    offs.forEach((f) => f());
  };
}

async function renderWakeRanking(view, { query }) {
  setHeader({ title: "起床ランキング", back: "/team?tab=wakeup" });
  const season = query.season || "";
  const r = await get(`/wakeups/ranking${season ? `?season=${encodeURIComponent(season)}` : ""}`);
  mount(
    view,
    html`<div class="row gap cm-season">
        <a class="btn btn-sm btn-ghost" href="#/wakeup/ranking?season=${r.season - 1}">‹ ${r.season - 1}</a>
        <span class="grow center strong">${r.season}シーズン ・ ${r.events}試合/練習</span>
        <a class="btn btn-sm btn-ghost" href="#/wakeup/ranking?season=${r.season + 1}">${r.season + 1} ›</a>
      </div>
      ${rankingCard(r, { full: true })}
      <p class="hint center">一番乗りの回数が多い順。同数なら集合時間より早く起きている人が上位です</p>`,
  );
}

// ================================================================ 練習報告
export const KINDS = {
  swing: { label: "素振り", icon: "🏏", unit: "回", presets: [100, 200, 300, 500], step: 10 },
  run: { label: "ランニング", icon: "🏃", unit: "km", presets: [1, 3, 5, 10], step: 0.5 },
  catch: { label: "キャッチボール", short: "キャッチ", icon: "🧤", unit: "分", presets: [10, 20, 30, 60], step: 5 },
  knock: { label: "ノック", icon: "🥎", unit: "球", presets: [30, 50, 100, 200], step: 10 },
  batting: { label: "バッティングセンター", short: "バッセン", icon: "🎯", unit: "球", presets: [20, 40, 60, 100], step: 10 },
  training: { label: "筋トレ", icon: "💪", unit: "分", presets: [15, 30, 45, 60], step: 5 },
  pitching: { label: "ピッチング", icon: "⚾", unit: "球", presets: [30, 50, 80, 100], step: 10 },
  other: { label: "その他", icon: "✨", unit: "分", presets: [10, 20, 30, 60], step: 5 },
};
const UNITS = ["回", "km", "分", "球", "セット"];
const STEP_BY_UNIT = { 回: 10, km: 0.5, 分: 5, 球: 10, セット: 1 };

const itemChip = (it) => {
  const k = KINDS[it.kind] || KINDS.other;
  return html`<span class="cm-item"><span class="cm-item-ico">${k.icon}</span>${it.kind === "other" ? it.label || k.label : k.short || k.label}<b class="num">${fmtAmount(it.amount)}</b><small>${it.unit}</small></span>`;
};

function practiceCard(p) {
  return html`<article class="card cm-practice" data-id="${p.id}">
    <div class="row gap">
      ${avatar(p.member, "md")}
      <div class="grow" style="min-width:0">
        <p class="strong ellipsis">${p.member ? memberLabel(p.member) : "退団したメンバー"}</p>
        <p class="small muted">${p.date === todayStr() ? "今日" : fmtDate(p.date)} の練習 ・ ${ago(p.createdAt)}</p>
      </div>
      ${p.mine || isAdmin() ? html`<button class="icon-btn" data-act="pmenu" data-id="${p.id}" aria-label="メニュー">⋯</button>` : ""}
    </div>
    <div class="cm-items">${p.items.map(itemChip)}</div>
    ${p.comment ? html`<p class="cm-practice-cmt">${linkify(p.comment)}</p>` : ""}
    <div class="row gap cm-like-row">
      <button class="cm-like ${p.liked ? "on" : ""}" data-act="${p.liked ? "unlike" : "like"}" data-id="${p.id}" aria-pressed="${p.liked}">
        <span class="cm-like-ico">👏</span>ナイス！<b class="num">${p.likeCount || ""}</b>
      </button>
      <div class="avatars grow">${p.likers.slice(0, 6).map((m) => avatar(m, "xs"))}</div>
      ${p.likers.length > 6 ? html`<span class="small muted">+${p.likers.length - 6}</span>` : ""}
    </div>
  </article>`;
}

function heatmap(s) {
  return html`<div class="cm-heat" role="img" aria-label="直近12週の練習カレンダー">
    ${s.calendar.map(
      (d) => html`<i class="${d.future ? "f" : d.count >= 2 ? "l3" : d.count ? "l2" : ""} ${d.date === s.today ? "today" : ""}" title="${d.date} ${d.count ? `${d.count}件` : ""}"></i>`,
    )}
  </div>
  <div class="row cm-heat-legend small muted"><span class="grow">12週間前</span><span>少</span><i></i><i class="l2"></i><i class="l3"></i><span>多</span></div>`;
}

function streakCard(s, { compact = false } = {}) {
  const fire = s.streak >= 7 ? "🔥🔥🔥" : s.streak >= 3 ? "🔥🔥" : s.streak ? "🔥" : "🌱";
  return html`<section class="card card-hero cm-streak ${s.streak ? "hot" : ""}">
    <div class="row gap">
      <div class="cm-streak-main grow">
        <p class="small muted">${s.practicedToday ? "今日も練習した！" : s.streak ? "今日も続けよう" : "今日からはじめよう"}</p>
        <p class="cm-streak-n">練習 ${cnt(s.streak, "amber")}<span>日連続</span> <span class="cm-fire">${fire}</span></p>
        ${s.bestStreak > s.streak ? html`<p class="small muted">自己ベスト ${s.bestStreak}日</p>` : s.streak > 1 ? html`<p class="small amber">自己ベスト更新中！</p>` : ""}
      </div>
    </div>
    <div class="tiles cm-tiles">
      <div class="tile"><p class="tile-label">今月の練習</p><p class="tile-value">${cnt(s.monthDays)}<small>日</small></p></div>
      <div class="tile"><p class="tile-label">今月の素振り</p><p class="tile-value">${cnt(s.monthSwings)}<small>回</small></p></div>
      <div class="tile"><p class="tile-label">今月の走行</p><p class="tile-value">${cnt(s.monthRunKm)}<small>km</small></p></div>
    </div>
    ${compact ? "" : heatmap(s)}
  </section>`;
}

const RANK_TABS = [
  ["days", "練習日数", (x) => html`<b class="num amber">${x.days}</b><small>日</small>`],
  ["swings", "素振り", (x) => html`<b class="num amber">${fmtAmount(x.swings)}</b><small>回</small>`],
  ["run", "ランニング", (x) => html`<b class="num amber">${x.runKm}</b><small>km</small>`],
];

function practiceRanking(r, tab) {
  const [, , val] = RANK_TABS.find(([k]) => k === tab) || RANK_TABS[0];
  const list = r[tab] || [];
  const month = Number(r.month.slice(5));
  return html`<section class="card" data-ranking>
    <div class="card-head"><p class="card-title"><span class="icon">🏆</span>${month}月の練習ランキング</p></div>
    <div class="segmented cm-seg-sm">${RANK_TABS.map(([k, label]) => html`<button type="button" class="${k === tab ? "active" : ""}" data-act="rtab" data-value="${k}">${label}</button>`)}</div>
    ${list.length
      ? html`<div class="cm-rank-list">${list.slice(0, 10).map(
          (x, i) => html`<div class="cm-rank-row ${x.member.id === state.member.id ? "me" : ""}">
            <span class="cm-rank-pos">${["🥇", "🥈", "🥉"][i] || html`<span class="num">${i + 1}</span>`}</span>
            ${avatar(x.member, "sm")}<span class="grow ellipsis strong">${x.member.name}</span>
            <span class="cm-rank-val">${val(x)}</span>
          </div>`,
        )}</div>`
      : html`<p class="small muted center cm-pad">今月はまだ記録がありません。一番乗りのチャンス！</p>`}
  </section>`;
}

async function practiceSection(box) {
  let rtab = "days";
  const [{ practices, hasMore }, summary, ranking] = await Promise.all([get("/practices?limit=20"), get("/practices/summary"), get("/practices/ranking")]);
  let feed = practices;
  let more = hasMore;
  const draw = () => {
    mount(
      box,
      html`${streakCard(summary)}
        <div data-rank-slot>${practiceRanking(ranking, rtab)}</div>
        <p class="section-title"><span>みんなの練習</span></p>
        ${feed.length
          ? html`<div class="stack" data-feed>${feed.map(practiceCard)}</div>
              ${more ? html`<button class="btn btn-ghost btn-block" data-act="more">もっと見る</button>` : ""}`
          : empty("まだ練習報告がありません。素振り1回からでも記録しよう！", { icon: "🏏" })}
        ${fab({ label: "練習を記録", short: "記録", href: "#/practice/new" })}`,
    );
    countUp(box);
  };
  draw();

  const replaceCard = (p) => {
    feed = feed.map((x) => (x.id === p.id ? p : x));
    const el = box.querySelector(`.cm-practice[data-id="${p.id}"]`);
    if (!el) return;
    const tmp = document.createElement("div");
    mount(tmp, practiceCard(p));
    el.replaceWith(tmp.firstElementChild);
    return box.querySelector(`.cm-practice[data-id="${p.id}"]`);
  };

  const offs = [
    on(box, "click", "[data-act=rtab]", (_, b) => {
      rtab = b.dataset.value;
      mount(box.querySelector("[data-rank-slot]"), practiceRanking(ranking, rtab));
    }),
    on(box, "click", "[data-act=like],[data-act=unlike]", (_, b) =>
      busy(b, async () => {
        const like = b.dataset.act === "like";
        const id = Number(b.dataset.id);
        const { practice } = like ? await post(`/practices/${id}/like`) : await del(`/practices/${id}/like`);
        const el = replaceCard(practice);
        if (like) {
          navigator.vibrate?.(10);
          el?.querySelector(".cm-like")?.classList.add("pop");
        }
      }),
    ),
    on(box, "click", "[data-act=more]", (_, b) =>
      busy(b, async () => {
        const res = await get(`/practices?limit=20&before=${feed.at(-1).id}`);
        feed = [...feed, ...res.practices];
        more = res.hasMore;
        draw();
      }),
    ),
    on(box, "click", "[data-act=pmenu]", (_, b) => {
      const p = feed.find((x) => x.id === Number(b.dataset.id));
      sheet({
        title: "練習報告",
        body: html`<div class="stack">
          ${p.mine ? html`<a class="btn btn-block" href="#/practice/new?edit=${p.id}" data-sheet-close>✏️ 編集する</a>` : ""}
          <button class="btn btn-block btn-danger" data-x="delete">🗑 削除する</button>
        </div>`,
        onMount(el, close) {
          el.querySelector("[data-x=delete]").onclick = async () => {
            close();
            if (!(await confirmDialog("この練習報告を削除しますか？", { ok: "削除", danger: true }))) return;
            try {
              await del(`/practices/${p.id}`);
              feed = feed.filter((x) => x.id !== p.id);
              Object.assign(summary, await get("/practices/summary"));
              draw();
              toast("削除しました");
            } catch (err) {
              toastError(err);
            }
          };
        },
      });
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 練習を記録
function itemRow(it, i) {
  const k = KINDS[it.kind] || KINDS.other;
  return html`<div class="cm-entry" data-i="${i}">
    <div class="row gap">
      <span class="cm-entry-ico">${k.icon}</span>
      ${it.kind === "other"
        ? html`<input class="input cm-entry-label" data-f="label" maxlength="20" value="${it.label || ""}" placeholder="練習の名前（例: ストレッチ）" />`
        : html`<span class="strong grow">${k.label}</span>`}
      <button type="button" class="icon-btn" data-act="remove" aria-label="${k.label}を外す">✕</button>
    </div>
    <div class="cm-amount">
      <button type="button" class="stepper-btn" data-act="dec" aria-label="減らす">−</button>
      <input class="cm-amount-input num" data-f="amount" type="number" inputmode="decimal" min="0" step="any" value="${it.amount}" aria-label="量" />
      <select class="select cm-unit" data-f="unit" aria-label="単位">${UNITS.map((u) => html`<option ${u === it.unit ? "selected" : ""}>${u}</option>`)}</select>
      <button type="button" class="stepper-btn" data-act="inc" aria-label="増やす">＋</button>
    </div>
    <div class="cm-presets">${k.presets.map((n) => html`<button type="button" class="cm-preset ${Number(it.amount) === n && it.unit === k.unit ? "on" : ""}" data-act="preset" data-n="${n}">${n}${k.unit}</button>`)}</div>
  </div>`;
}

async function renderPracticeNew(view, { query }) {
  const editId = query.edit ? Number(query.edit) : null;
  let p = null;
  if (editId) p = (await get(`/practices/${editId}`)).practice;
  setHeader({ title: p ? "練習報告を編集" : "練習を記録", back: "/team?tab=practice" });
  const today = todayStr();
  const yesterday = addDaysStr(today, -1);
  let items = p ? p.items.map((x) => ({ ...x })) : [];

  mount(
    view,
    html`<form class="form" id="cm-pform">
      <section class="card">
        <p class="field-label">いつの練習？</p>
        <div class="row gap cm-datepick">
          <label class="pill"><input type="radio" name="dq" value="${today}" ${!p || p.date === today ? "checked" : ""} /><span>今日</span></label>
          <label class="pill"><input type="radio" name="dq" value="${yesterday}" ${p?.date === yesterday ? "checked" : ""} /><span>昨日</span></label>
          <input class="input grow" type="date" name="date" max="${today}" value="${p?.date || today}" aria-label="日付" />
        </div>
      </section>
      <section class="card">
        <p class="field-label">メニューをタップして追加</p>
        <div class="cm-kinds">
          ${Object.entries(KINDS).map(
            ([key, k]) => html`<button type="button" class="cm-kind" data-act="kind" data-kind="${key}"><span>${k.icon}</span><small>${k.short || k.label}</small></button>`,
          )}
        </div>
        <div class="stack cm-entries" data-entries></div>
      </section>
      <section class="card">
        <div class="field"><label>ひとこと（任意）</label><textarea class="textarea" name="comment" maxlength="300" rows="3" placeholder="例: 雨だったので室内で。明日も頑張る！">${p?.comment || ""}</textarea></div>
      </section>
      <div class="savebar"><button class="btn btn-primary btn-block" type="submit">${p ? "保存する" : "💪 記録する"}</button></div>
    </form>`,
  );
  const form = $("#cm-pform", view);
  const entries = form.querySelector("[data-entries]");
  const drawItems = () => {
    mount(entries, items.length ? html`${items.map(itemRow)}` : html`<p class="small muted center cm-pad">上のメニューから選んでね（複数OK）</p>`);
    for (const b of form.querySelectorAll("[data-act=kind]")) b.classList.toggle("on", items.some((x) => x.kind === b.dataset.kind));
  };
  drawItems();

  const idx = (el) => Number(el.closest("[data-i]").dataset.i);
  const offs = [
    on(form, "click", "[data-act=kind]", (_, b) => {
      const kind = b.dataset.kind;
      const k = KINDS[kind];
      items.push({ kind, amount: k.presets[0], unit: k.unit });
      drawItems();
      navigator.vibrate?.(5);
      entries.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }),
    on(form, "click", "[data-act=remove]", (_, b) => {
      items.splice(idx(b), 1);
      drawItems();
    }),
    on(form, "click", "[data-act=preset]", (_, b) => {
      const it = items[idx(b)];
      it.amount = Number(b.dataset.n);
      it.unit = (KINDS[it.kind] || KINDS.other).unit;
      drawItems();
    }),
    on(form, "click", "[data-act=inc],[data-act=dec]", (_, b) => {
      const it = items[idx(b)];
      const step = STEP_BY_UNIT[it.unit] || 1;
      const next = Math.max(0, Math.round(((Number(it.amount) || 0) + (b.dataset.act === "inc" ? step : -step)) * 10) / 10);
      it.amount = next;
      const row = b.closest("[data-i]");
      row.querySelector("[data-f=amount]").value = next;
      for (const pb of row.querySelectorAll(".cm-preset")) pb.classList.toggle("on", Number(pb.dataset.n) === next);
      navigator.vibrate?.(5);
    }),
    on(form, "input", "[data-f]", (_, el) => {
      const it = items[idx(el)];
      it[el.dataset.f] = el.dataset.f === "amount" ? Number(el.value) : el.value;
    }),
    on(form, "change", "[data-f=unit]", (_, el) => {
      items[idx(el)].unit = el.value;
    }),
    on(form, "change", "[name=dq]", (_, el) => {
      form.querySelector("[name=date]").value = el.value;
    }),
    on(form, "change", "[name=date]", (_, el) => {
      for (const r of form.querySelectorAll("[name=dq]")) r.checked = r.value === el.value;
    }),
  ];

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    if (!items.length) return toast("メニューを1つ以上選んでね", { type: "error" });
    busy(btn, async () => {
      const body = { date: form.querySelector("[name=date]").value, items, comment: form.querySelector("[name=comment]").value };
      if (p) {
        await patch(`/practices/${p.id}`, body);
        toast("保存しました", { type: "success" });
      } else {
        const { summary } = await post("/practices", body);
        celebrate();
        splash({
          icon: summary.streak >= 3 ? "🔥" : "💪",
          big: String(summary.streak || summary.monthDays),
          text: summary.streak ? "日連続の練習！" : `今月${summary.monthDays}日目の練習！`,
          sub: "ナイス練習！この積み重ねが打席に出る",
          tone: "green",
        });
      }
      navigate("/team?tab=practice", { replace: true });
    });
  });
  return () => offs.forEach((f) => f());
}

// ================================================================ /team ハブ
const TABS = [
  ["notices", "📣 お知らせ"],
  ["wakeup", "☀️ 起床"],
  ["practice", "🏏 練習"],
];

async function renderTeam(view, { query }) {
  setHeader({ title: "チーム" });
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : "notices";
  let cleanup = null;
  let seq = 0;
  mount(
    view,
    html`<div class="segmented cm-tabs" role="tablist">
        ${TABS.map(([k, label]) => html`<button type="button" role="tab" class="${k === tab ? "active" : ""}" data-tab="${k}" aria-selected="${k === tab}">${label}<span class="badge" data-badge="${k}" hidden></span></button>`)}
      </div>
      <div data-section></div>`,
  );
  const box = view.querySelector("[data-section]");

  const updateBadge = () =>
    get("/notices/pending")
      .then(({ count }) => {
        const b = view.querySelector("[data-badge=notices]");
        if (!b) return;
        b.textContent = count;
        b.hidden = !count;
      })
      .catch(() => {});

  const show = async () => {
    const my = ++seq;
    if (typeof cleanup === "function") cleanup();
    cleanup = null;
    for (const b of view.querySelectorAll("[data-tab]")) {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", b.dataset.tab === tab);
    }
    const inner = document.createElement("div");
    inner.className = "cm-section";
    box.replaceChildren(inner);
    mount(inner, loading());
    try {
      const fn = { notices: noticesSection, wakeup: wakeSection, practice: practiceSection }[tab];
      const c = await fn(inner);
      if (my !== seq) return c?.();
      cleanup = c;
    } catch (err) {
      if (my !== seq) return;
      console.error(err);
      mount(inner, empty(err.message || "読み込みに失敗しました", { icon: "⚠️", action: html`<button class="btn" data-act="retry">もう一度読み込む</button>` }));
    }
  };

  const offRetry = on(view, "click", "[data-act=retry]", () => show());
  const off = on(view, "click", "[data-tab]", (_, b) => {
    if (b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    history.replaceState(null, "", `#/team?tab=${tab}`);
    show();
    updateBadge();
  });
  updateBadge();
  await show();
  return () => {
    seq++;
    off();
    offRetry();
    if (typeof cleanup === "function") cleanup();
  };
}

// 単独ページ（/wakeup, /practice）
function standalone(fn, title, back) {
  return async (view, { params }) => {
    setHeader({ title, back });
    return fn(view, { eventId: params.eventId });
  };
}

// ================================================================ ホームカード
const homeWake = {
  order: 5,
  render: async () => {
    const { events } = await get("/wakeups/today");
    const b = events.find((x) => x.beforeStart);
    if (!b) return "";
    const me = b.me.wakeup;
    const e = b.event;
    if (!me) {
      return html`<section class="card cm-home-wake" data-event="${e.id}" data-todo="1">
        <div class="cm-sunrise" aria-hidden="true"></div>
        <p class="small strong amber">今日は${e.type === "game" ? "試合" : e.type === "practice" ? "練習" : "予定"}の日！</p>
        <p class="strong ellipsis">${e.title}${e.meetTime ? html` ・ 集合 ${e.meetTime}` : ""}</p>
        <button class="cm-wake-btn cm-wake-home" data-act="home-wake"><span class="cm-wake-sun">☀️</span><span class="cm-wake-label">起きた！</span>
          <span class="cm-wake-hint">${b.counts.woke ? `${b.counts.woke}人がもう起きてる` : "一番乗りのチャンス！"}</span></button>
      </section>`;
    }
    return html`<a class="card card-link cm-home-woke" href="#/wakeup/${e.id}">
      <div class="cm-medal ${me.rank === 1 ? "gold" : me.rank <= 3 ? "silver" : ""}"><span class="num">${me.rank}</span></div>
      <div class="grow"><p class="strong">${me.rank}番目に起床 ☀️</p>
        <p class="small muted">${b.counts.wokeAttending} / ${b.counts.attending}人が起きてる ・ ${e.title}</p></div>
      <span class="chev">›</span>
    </a>`;
  },
  bind: (el) => {
    const b = el.querySelector("[data-act=home-wake]");
    if (!b) return;
    const id = el.querySelector("[data-event]").dataset.event;
    b.addEventListener("click", () =>
      busy(b, async () => {
        const res = await post(`/wakeups/${id}`, { stage: "woke" });
        if (res.rank === 1) {
          celebrate();
          splash({ icon: "🥇", big: "1", text: "番乗りの起床！", sub: "今日のチームで一番早起き！" });
        } else splash({ icon: "☀️", big: String(res.rank), text: "番目の起床！", sub: `${res.counts.woke}人が起きてます` });
        mount(el, await homeWake.render());
      }),
    );
  },
};

const homeNotice = {
  order: 15,
  render: async () => {
    const { count, notice: n } = await get("/notices/pending");
    if (!n) return "";
    const cat = CATS[n.category] || CATS.info;
    return html`<section class="card cm-home-notice cm-cat-${n.category}" data-todo="${count}">
      <div class="row gap">
        <span class="chip ${cat.chip}">${cat.icon} ${cat.label}</span>
        <span class="small muted grow">${n.author?.name || ""} ・ ${ago(n.createdAt)}</span>
        ${count > 1 ? html`<a class="small" href="#/team?tab=notices">ほか${count - 1}件 ›</a>` : ""}
      </div>
      <a class="cm-home-notice-body" href="#/notices/${n.id}">
        ${n.title ? html`<p class="strong">${n.title}</p>` : ""}
        <p class="cm-clamp">${n.body}</p>
      </a>
      <div class="row gap">
        <span class="small muted grow">了解 ${n.ackCount} / ${n.total}人</span>
        <button class="btn btn-primary cm-ack-btn" data-act="home-ack" data-id="${n.id}">👍 了解！</button>
      </div>
    </section>`;
  },
  bind: (el) => {
    const b = el.querySelector("[data-act=home-ack]");
    if (!b) return;
    b.addEventListener("click", () =>
      busy(b, async () => {
        await doAck(Number(b.dataset.id), true);
        const card = el.querySelector(".cm-home-notice");
        card.classList.add("cm-acked-out");
        mount(card.querySelector(".row:last-child"), html`<span class="cm-stamp pop">了解！</span>`);
        setTimeout(async () => {
          const next = await homeNotice.render().catch(() => "");
          if (!String(next)) return el.remove();
          mount(el, next);
          homeNotice.bind(el);
        }, 1100);
      }),
    );
  },
};

const homePractice = {
  order: 42,
  render: async () => {
    const s = await get("/practices/summary");
    const fire = s.streak >= 3 ? "🔥🔥" : s.streak ? "🔥" : "🌱";
    return html`<section class="card cm-home-practice">
      <div class="row gap">
        <div class="grow">
          <p class="card-sub">${s.practicedToday ? "今日も練習した！ナイス！" : s.streak ? "連続記録を伸ばそう" : "今日から自主練を記録しよう"}</p>
          <p class="cm-streak-n">練習 ${cnt(s.streak, "amber")}<span>日連続</span> <span class="cm-fire">${fire}</span></p>
          <p class="small muted">今月 <b class="num">${s.monthDays}</b>日 ・ 素振り <b class="num">${fmtAmount(s.monthSwings)}</b>回</p>
        </div>
        <a class="btn ${s.practicedToday ? "" : "btn-primary"}" href="#/practice/new">🏏 練習を記録</a>
      </div>
    </section>`;
  },
  bind: (el) => countUp(el),
};

export default {
  name: "community",
  routes: {
    "/team": renderTeam,
    "/notices/:id": renderNotice,
    "/wakeup": standalone(wakeSection, "起床報告", "/team?tab=wakeup"),
    "/wakeup/ranking": renderWakeRanking,
    "/wakeup/:eventId": standalone(wakeSection, "起床報告", "/team?tab=wakeup"),
    "/practice": standalone(practiceSection, "練習報告", "/team?tab=practice"),
    "/practice/new": renderPracticeNew,
  },
  homeCards: [homeWake, homeNotice, homePractice],
  menu: [
    { path: "/team?tab=notices", label: "お知らせ", icon: "📣", order: 30 },
    { path: "/wakeup/ranking", label: "起床ランキング", icon: "🐓", order: 31 },
    { path: "/practice", label: "練習報告・ランキング", icon: "🏏", order: 32 },
  ],
};
