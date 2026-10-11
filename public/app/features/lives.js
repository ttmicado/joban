// お笑いライブ（アミダラインなど）の告知と、選手の参加意思
import { appUrl, del, get, html, isAdmin, mount, navigate, on, patch, post, put, setHeader } from "../core.js";
import {
  avatar,
  busy,
  celebrate,
  confirmDialog,
  countUp,
  daysFrom,
  empty,
  fab,
  fmtDate,
  mapUrl,
  multiline,
  readForm,
  relDay,
  segmented,
  share,
  sheet,
  toast,
  toastError,
  weekday,
  weekdayClass,
} from "../ui.js";
import { flexMessage, simpleBubble } from "../lib/flex.js";

const STATUS = {
  go: { label: "行く！", short: "行く", icon: "🎤", cls: "go" },
  maybe: { label: "迷い中", short: "迷い中", icon: "🤔", cls: "maybe" },
  no: { label: "行けない", short: "行けない", icon: "🙏", cls: "no" },
};

const yen = (n) => (n === null || n === undefined ? "" : `¥${Number(n).toLocaleString("ja-JP")}`);

function priceText(l) {
  const parts = [];
  if (l.priceAdvance !== null && l.priceAdvance !== undefined) parts.push(`前売 ${yen(l.priceAdvance)}`);
  if (l.priceDoor !== null && l.priceDoor !== undefined) parts.push(`当日 ${yen(l.priceDoor)}`);
  return parts.join(" / ");
}

function timeText(l) {
  return [l.openTime && `開場 ${l.openTime}`, l.startTime && `開演 ${l.startTime}`].filter(Boolean).join(" / ");
}

// ---------------------------------------------------------------- 一覧
function liveRow(l) {
  const d = new Date(`${l.date}T00:00:00`);
  const canceled = l.status === "canceled";
  return html`<a class="list-item lv-row ${canceled ? "lv-canceled" : ""}" href="#/lives/${l.id}">
    <div class="datebox">
      <p class="datebox-m">${d.getMonth() + 1}月</p>
      <p class="datebox-d">${d.getDate()}</p>
      <p class="datebox-w ${weekdayClass(l.date)}">${weekday(l.date)}</p>
    </div>
    <div class="list-main">
      <p class="list-title">${canceled ? html`<span class="chip chip-red">中止</span> ` : ""}${l.title}</p>
      <p class="list-sub">📍 ${l.venue}${l.startTime ? ` ・ 開演 ${l.startTime}` : ""}</p>
      <p class="list-sub">${priceText(l) || "料金未定"} ・ 🎤 行く ${l.counts.go}人</p>
    </div>
    ${l.my ? html`<span class="lv-mine ${STATUS[l.my.status].cls}">${STATUS[l.my.status].short}</span>` : html`<span class="chip chip-amber">未回答</span>`}
  </a>`;
}

async function renderList(view, { query }) {
  const range = query.range === "past" ? "past" : "upcoming";
  setHeader({ title: "お笑いライブ", back: "/more" });
  const { lives } = await get(`/lives?range=${range}`);
  mount(
    view,
    html`<section class="card lv-hero">
        <p class="lv-hero-kicker">チームの芸人を応援しよう</p>
        <p class="lv-hero-title">🎤 アミダライン ライブ情報</p>
        <p class="small muted">会場・時間・チケット代をチェックして、行けるかどうかを回答しよう</p>
      </section>
      ${segmented("range", [["upcoming", "これから"], ["past", "過去"]], range)}
      ${lives.length
        ? html`<div class="list">${lives.map(liveRow)}</div>`
        : empty(range === "past" ? "過去のライブはまだありません" : "予定されているライブはまだありません", { icon: "🎙" })}
      ${fab({ label: "ライブを登録", short: "登録", act: "new" })}`,
  );
  const offs = [
    on(view, "click", "[data-segmented=range] button", (_, b) => navigate(b.dataset.value === "past" ? "/lives?range=past" : "/lives")),
    on(view, "click", "[data-act=new]", () => openForm(null)),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 詳細
function rsvpButtons(l) {
  const cur = l.my?.status;
  return html`<div class="lv-rsvp">
    ${Object.entries(STATUS).map(
      ([k, s]) => html`<button type="button" class="lv-rsvp-btn ${s.cls} ${cur === k ? "on" : ""}" data-act="rsvp" data-status="${k}" ${l.status === "canceled" ? "disabled" : ""}>
        <span class="lv-rsvp-ico">${s.icon}</span><span>${s.label}</span>
      </button>`,
    )}
  </div>`;
}

function people(list, label, cls) {
  if (!list.length) return "";
  return html`<div class="lv-people">
    <p class="lv-people-head ${cls}">${label} <b class="num">${list.length}</b>人</p>
    <div class="lv-people-list">
      ${list.map(
        (x) => html`<div class="lv-person" data-member="${x.member.id}">
          ${avatar(x.member, "sm")}
          <span class="lv-person-name">${x.member.name}</span>
          ${x.tickets ? html`<span class="chip chip-amber">🎟 ${x.tickets}枚</span>` : ""}
          ${x.comment ? html`<span class="lv-person-comment">「${x.comment}」</span>` : ""}
        </div>`,
      )}
    </div>
  </div>`;
}

function shareMessage(l) {
  const rows = [
    ["日付", fmtDate(l.date)],
    ["時間", timeText(l)],
    ["会場", l.venue],
    ["料金", priceText(l) || l.priceNote],
  ].filter(([, v]) => v);
  return flexMessage(`🎤 ${l.title}（${fmtDate(l.date)}）`, simpleBubble({
    label: `🎤 ${l.performer || "お笑いライブ"}`,
    title: l.title,
    rows,
    body: l.note,
    accent: "#a78bfa",
    url: appUrl(`/lives/${l.id}`),
    buttonLabel: "行けるか回答する",
  }));
}

async function renderDetail(view, { params }) {
  let { live: l } = await get(`/lives/${encodeURIComponent(params.id)}`);
  setHeader({ title: "ライブ詳細", back: "/lives" });

  const draw = () => {
    const days = daysFrom(l.date);
    const canceled = l.status === "canceled";
    const by = (s) => l.rsvps.filter((x) => x.status === s);
    mount(
      view,
      html`<section class="card lv-detail-hero ${canceled ? "lv-canceled" : ""}">
          <p class="lv-performer">🎤 ${l.performer || "お笑いライブ"}</p>
          <h2 class="lv-title">${l.title}</h2>
          <div class="row gap wrap">
            ${canceled ? html`<span class="chip chip-red">中止</span>` : days >= 0 ? html`<span class="chip chip-purple">${relDay(l.date)}</span>` : html`<span class="chip">終了</span>`}
            <span class="chip">${fmtDate(l.date, { year: true })}</span>
          </div>
          <div class="lv-info">
            <div class="lv-info-row"><span class="lv-info-k">🕖 時間</span><span class="lv-info-v">${timeText(l) || "未定"}${l.endTime ? html`<span class="muted small">（終演 ${l.endTime}）</span>` : ""}</span></div>
            <div class="lv-info-row"><span class="lv-info-k">📍 会場</span><span class="lv-info-v">${l.venue}
              <a class="btn btn-sm lv-map" href="${l.venueUrl || mapUrl(l.venue)}" target="_blank" rel="noopener">地図</a></span></div>
            <div class="lv-info-row"><span class="lv-info-k">🎟 料金</span><span class="lv-info-v">
              ${priceText(l) ? html`<b class="lv-price">${priceText(l)}</b>` : "未定"}
              ${l.priceNote ? html`<span class="muted small">${l.priceNote}</span>` : ""}</span></div>
          </div>
          ${l.ticketUrl ? html`<a class="btn btn-block" href="${l.ticketUrl}" target="_blank" rel="noopener">🎫 チケット購入ページを開く</a>` : ""}
          ${l.note ? html`<p class="lv-note">${multiline(l.note)}</p>` : ""}
        </section>

        <section class="card">
          <div class="card-head"><p class="card-title"><span class="icon">🙋</span>あなたは行けますか？</p>
            ${l.my ? html`<span class="lv-mine ${STATUS[l.my.status].cls}">回答済み</span>` : ""}</div>
          ${rsvpButtons(l)}
          ${l.my?.status === "go"
            ? html`<p class="small muted lv-tickets-line">🎟 取り置き ${l.my.tickets}枚${l.my.comment ? ` ・「${l.my.comment}」` : ""}
                <button class="btn btn-sm btn-ghost" data-act="edit-rsvp">変更</button></p>`
            : ""}
        </section>

        <section class="card">
          <div class="card-head"><p class="card-title"><span class="icon">👥</span>みんなの参加意思</p></div>
          <div class="tiles cols-4 lv-tiles">
            <div class="tile"><p class="tile-label">行く</p><p class="tile-value"><span data-count="${l.counts.go}">${l.counts.go}</span></p></div>
            <div class="tile"><p class="tile-label">迷い中</p><p class="tile-value"><span data-count="${l.counts.maybe}">${l.counts.maybe}</span></p></div>
            <div class="tile"><p class="tile-label">行けない</p><p class="tile-value"><span data-count="${l.counts.no}">${l.counts.no}</span></p></div>
            <div class="tile"><p class="tile-label">取り置き</p><p class="tile-value"><span data-count="${l.counts.tickets}">${l.counts.tickets}</span><small>枚</small></p></div>
          </div>
          ${people(by("go"), "🎤 行く", "go")}
          ${people(by("maybe"), "🤔 迷い中", "maybe")}
          ${people(by("no"), "🙏 行けない", "no")}
          ${l.unanswered.length
            ? html`<div class="lv-people">
                <p class="lv-people-head">まだ回答していない人 <b class="num">${l.unanswered.length}</b>人</p>
                <div class="avatars lv-unanswered">${l.unanswered.map((m) => html`<span title="${m.name}" data-member="${m.id}">${avatar(m, "sm")}</span>`)}</div>
              </div>`
            : ""}
          ${isAdmin() ? html`<p class="hint">管理者はアバターをタップすると代理で回答できます</p>` : ""}
        </section>

        <button class="btn btn-line btn-block" data-act="share">LINEでライブを宣伝する</button>
        ${l.canEdit
          ? html`<div class="row gap">
              <button class="btn btn-ghost grow" data-act="edit">✏️ 編集</button>
              <button class="btn btn-ghost grow" data-act="toggle-cancel">${canceled ? "中止を取り消す" : "中止にする"}</button>
              <button class="btn btn-ghost" data-act="delete" aria-label="削除">🗑</button>
            </div>`
          : ""}`,
    );
    countUp(view);
  };
  draw();

  const answer = (status, extra = {}, memberId = null) =>
    put(`/lives/${l.id}/rsvp`, { status, ...extra, ...(memberId ? { member_id: memberId } : {}) });

  // 「行く」は取り置き枚数とひとことを聞く
  const askGo = (memberId = null, cur = null) =>
    sheet({
      title: memberId ? "代理で回答（行く）" : "行く！🎤",
      body: html`<form class="form">
        <div class="field"><label>チケットの取り置き</label>
          <div class="pills">${[0, 1, 2, 3, 4].map((n) => html`<label class="pill"><input type="radio" name="tickets" value="${n}" ${(cur?.tickets ?? 1) === n ? "checked" : ""} /><span>${n ? `${n}枚` : "不要"}</span></label>`)}</div>
          <p class="hint">家族や友達の分もまとめて伝えられます</p>
        </div>
        <div class="field"><label>ひとこと（任意）</label><input class="input" name="comment" maxlength="100" value="${cur?.comment || ""}" placeholder="例: 仕事終わりに駆けつけます！" /></div>
        <button class="btn btn-primary btn-block" type="submit">回答する</button>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const f = readForm(form);
            ({ live: l } = await answer("go", { tickets: Number(f.tickets || 0), comment: f.comment }, memberId));
            close();
            draw();
            if (!memberId) {
              celebrate();
              toast("いってらっしゃい！アミダラインに伝えておきます🎤", { type: "success" });
            }
          });
        });
      },
    });

  const proxy = (memberId) => {
    const m = [...l.rsvps.map((x) => x.member), ...l.unanswered].find((x) => x.id === memberId);
    if (!m) return;
    sheet({
      title: `${m.name} の参加意思`,
      body: html`<div class="stack">${Object.entries(STATUS).map(([k, s]) => html`<button class="btn btn-block" data-st="${k}">${s.icon} ${s.label}</button>`)}</div>`,
      onMount(el, close) {
        on(el, "click", "[data-st]", (_, b) => {
          close();
          if (b.dataset.st === "go") return askGo(memberId);
          answer(b.dataset.st, {}, memberId)
            .then((r) => ((l = r.live), draw()))
            .catch(toastError);
        });
      },
    });
  };

  const offs = [
    on(view, "click", "[data-act=rsvp]", (_, b) => {
      const st = b.dataset.status;
      if (st === "go") return askGo(null, l.my);
      busy(b, async () => {
        ({ live: l } = await answer(st));
        draw();
        toast(st === "maybe" ? "決まったらまた教えてね" : "了解！また次の機会に", { type: "success" });
      });
    }),
    on(view, "click", "[data-act=edit-rsvp]", () => askGo(null, l.my)),
    on(view, "click", "[data-member]", (_, el) => isAdmin() && proxy(Number(el.dataset.member))),
    on(view, "click", "[data-act=share]", () => share([shareMessage(l)])),
    on(view, "click", "[data-act=edit]", () => openForm(l, (nl) => ((l = nl), draw()))),
    on(view, "click", "[data-act=toggle-cancel]", async () => {
      const canceled = l.status === "canceled";
      if (!(await confirmDialog(canceled ? "中止を取り消しますか？" : "このライブを中止にしますか？", { danger: !canceled }))) return;
      try {
        ({ live: l } = await patch(`/lives/${l.id}`, { status: canceled ? "scheduled" : "canceled" }));
        draw();
      } catch (err) {
        toastError(err);
      }
    }),
    on(view, "click", "[data-act=delete]", async () => {
      if (!(await confirmDialog("このライブを削除しますか？参加意思も消えます。", { ok: "削除", danger: true }))) return;
      try {
        await del(`/lives/${l.id}`);
        toast("削除しました");
        navigate("/lives", { replace: true });
      } catch (err) {
        toastError(err);
      }
    }),
  ];
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- 登録・編集
function openForm(l, onSaved) {
  const x = l || { performer: "アミダライン" };
  sheet({
    title: l ? "ライブを編集" : "ライブを登録",
    body: html`<form class="form">
      <div class="field"><label>タイトル</label><input class="input" name="title" maxlength="60" required value="${x.title || ""}" placeholder="例: アミダライン単独ライブ" /></div>
      <div class="field"><label>出演</label><input class="input" name="performer" maxlength="60" value="${x.performer || ""}" /></div>
      <div class="field"><label>日付</label><input class="input" type="date" name="date" required value="${x.date || ""}" /></div>
      <div class="grid-2">
        <div class="field"><label>開場</label><input class="input" type="time" name="open_time" value="${x.openTime || ""}" /></div>
        <div class="field"><label>開演</label><input class="input" type="time" name="start_time" value="${x.startTime || ""}" /></div>
      </div>
      <div class="field"><label>終演（任意）</label><input class="input" type="time" name="end_time" value="${x.endTime || ""}" /></div>
      <div class="field"><label>会場</label><input class="input" name="venue" maxlength="60" required value="${x.venue || ""}" placeholder="例: 新宿バティオス" /></div>
      <div class="field"><label>地図URL（任意）</label><input class="input" type="url" name="venue_url" value="${x.venueUrl || ""}" placeholder="空なら会場名で地図を検索します" /></div>
      <div class="grid-2">
        <div class="field"><label>前売（円）</label><input class="input num" type="number" inputmode="numeric" min="0" name="price_advance" value="${x.priceAdvance ?? ""}" /></div>
        <div class="field"><label>当日（円）</label><input class="input num" type="number" inputmode="numeric" min="0" name="price_door" value="${x.priceDoor ?? ""}" /></div>
      </div>
      <div class="field"><label>料金のメモ（任意）</label><input class="input" name="price_note" maxlength="100" value="${x.priceNote || ""}" placeholder="例: 別途1ドリンク500円" /></div>
      <div class="field"><label>チケット購入URL（任意）</label><input class="input" type="url" name="ticket_url" value="${x.ticketUrl || ""}" /></div>
      <div class="field"><label>メモ（任意）</label><textarea class="textarea" name="note" maxlength="1000" placeholder="見どころ・取り置きの方法など">${x.note || ""}</textarea></div>
      <button class="btn btn-primary btn-block" type="submit">${l ? "保存" : "登録してみんなに知らせる"}</button>
    </form>`,
    onMount(el, close) {
      const form = el.querySelector("form");
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(form.querySelector("[type=submit]"), async () => {
          const body = readForm(form);
          if (l) {
            const { live } = await patch(`/lives/${l.id}`, body);
            close();
            toast("保存しました", { type: "success" });
            onSaved?.(live);
          } else {
            const { live } = await post("/lives", body);
            close();
            celebrate();
            toast("ライブを登録しました！", { type: "success" });
            navigate(`/lives/${live.id}`);
          }
        });
      });
    },
  });
}

// ---------------------------------------------------------------- ホームカード
const homeLive = {
  order: 55,
  render: async () => {
    const { lives } = await get("/lives");
    const next = lives.find((l) => l.status !== "canceled");
    if (!next) return "";
    return html`<a class="card card-link lv-home" href="#/lives/${next.id}">
      <div class="card-head">
        <p class="card-title"><span class="icon">🎤</span>${next.performer || "お笑いライブ"}のライブ</p>
        <span class="chip chip-purple">${relDay(next.date)}</span>
      </div>
      <p class="strong">${next.title}</p>
      <p class="small muted">${fmtDate(next.date)} ${timeText(next)} ・ 📍${next.venue}</p>
      <p class="small">${priceText(next) ? html`🎟 ${priceText(next)}` : ""}</p>
      <p class="small lv-home-foot">🎤 行く ${next.counts.go}人 ・ ${
        next.my ? html`あなたは<b>${STATUS[next.my.status].short}</b>` : html`<b class="amber">まだ回答していません →</b>`
      }</p>
    </a>`;
  },
};

export default {
  name: "lives",
  routes: {
    "/lives": renderList,
    "/lives/:id": renderDetail,
  },
  homeCards: [homeLive],
  menu: [{ path: "/lives", label: "お笑いライブ（アミダライン）", icon: "🎤", order: 35 }],
};
