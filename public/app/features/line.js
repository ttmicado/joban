// LINE通知（公式アカウント連携）の設定画面
import { get, html, isAdmin, mount, on, patch, post, raw, setHeader } from "../core.js";
import { ago, bgImage, busy, copyText, sheet, toast, toastError } from "../ui.js";

const WEBHOOK_PATH = "/api/line/webhook";

// 非管理者向けの説明にも使う一覧（サーバーの KINDS と同じ並び）
const PREVIEW = [
  ["📅", "予定の追加・変更・中止", "日付・集合時間・球場が変わったらすぐ届きます"],
  ["🗳", "日程調整の開始・決定", "候補日の募集と、決まった日程"],
  ["🏆", "試合結果", "スコアボード付きで速報"],
  ["📣", "お知らせ・新メンバー", "重要な連絡と新しい仲間の紹介"],
  ["⏰", "自動リマインド", "前日の集合案内・当日の起床チェック・出欠締切・成績入力"],
];

const COMMANDS = [
  ["次の予定", "次の予定の日時・集合・球場"],
  ["出欠", "次の予定の出欠状況と未回答者"],
  ["ランキング", "今季の打撃ランキング"],
  ["ヘルプ", "コマンド一覧とアプリのリンク"],
];

const KIND_LABEL = {
  test: "テスト",
  eventCreated: "新しい予定",
  eventChanged: "予定の変更",
  poll: "日程調整",
  gameResult: "試合結果",
  notice: "お知らせ",
  memberJoined: "新メンバー",
  remindEve: "前日リマインド",
  wakeup: "起床チェック",
  rsvpDeadline: "出欠締切",
  statsInput: "成績入力",
};

const lineIcon = raw(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5s5.9-3.5 8-5.9c1.5-1.6 2-3.2 2-4.9C22 6.6 17.5 3 12 3z"/></svg>`,
);

function commandList() {
  return html`<div class="line-cmds">
    ${COMMANDS.map(([cmd, desc]) => html`<div class="line-cmd"><span class="line-bubble">${cmd}</span><span class="small muted">${desc}</span></div>`)}
  </div>`;
}

function memberView(view) {
  mount(
    view,
    html`<section class="card card-hero line-hero">
        <div class="row gap">
          <span class="line-logo">${lineIcon}</span>
          <div class="grow">
            <p class="card-title">チームのLINEグループに自動でお知らせ</p>
            <p class="small muted">設定は管理者（監督・マネージャー）が行います</p>
          </div>
        </div>
      </section>
      <p class="section-title">届く通知</p>
      <div class="list">
        ${PREVIEW.map(([icon, t, d]) => html`<div class="list-item"><span class="line-kind-icon">${icon}</span><div class="list-main"><p class="list-title">${t}</p><p class="list-sub">${d}</p></div></div>`)}
      </div>
      <p class="section-title">グループで使えるコマンド</p>
      <div class="card">${commandList()}</div>`,
  );
}

function setupSteps(webhookUrl) {
  const steps = [
    ["LINE Developers で Messaging API チャネルを作成", "LIFF と同じプロバイダーに作ると、メンバーの紐づけがスムーズです"],
    ["チャネルアクセストークンとシークレットを登録", raw(`Vercel のプロジェクト → Settings → Environment Variables に <code>LINE_MESSAGING_TOKEN</code> と <code>LINE_MESSAGING_SECRET</code> を登録して Redeploy`)],
    ["Webhook URL を設定して「Webhookの利用」をオン", webhookUrl],
    ["応答メッセージ・あいさつメッセージをオフ", "LINE Official Account Manager の「応答設定」から"],
    ["「グループトーク・複数人トークへの参加を許可する」をオン", "LINE Official Account Manager の「アカウント設定」から"],
    ["公式アカウントをチームのグループに招待", "招待するとこの画面にグループが表示されます"],
    ["この画面で通知先のグループを選び、テスト送信", "届いたら完了です🎉"],
  ];
  return html`<ol class="line-steps">
      ${steps.map(([t, d], i) => html`<li><span class="line-step-no num">${i + 1}</span><div><p class="strong">${t}</p><p class="small muted line-break">${d}</p></div></li>`)}
    </ol>
    <p class="hint">詳しい手順はリポジトリの docs/LINE_SETUP.md を見てください</p>`;
}

function checklist(s) {
  const joinedGroups = s.groups.filter((g) => g.joined).length;
  const items = [
    [s.configured.token, "チャネルアクセストークン", s.configured.token ? "設定済み" : "LINE_MESSAGING_TOKEN が未設定"],
    [s.configured.secret, "チャネルシークレット", s.configured.secret ? "設定済み（署名を検証します）" : "LINE_MESSAGING_SECRET が未設定"],
    [joinedGroups > 0, "グループ連携", joinedGroups ? `${joinedGroups}件のグループを確認済み` : "公式アカウントをグループに招待してください"],
    [!!s.target?.joined, "通知先グループ", s.target ? (s.target.joined ? s.target.name || "名前未取得のグループ" : "公式アカウントが退出しています") : "下の一覧から選んでください"],
  ];
  const done = items.filter(([ok]) => ok).length;
  return { items, done, total: items.length };
}

function groupItem(g, selected) {
  const name = g.name || (g.type === "room" ? "複数人トーク" : "名前未取得のグループ");
  const avatarStyle = bgImage(g.picture);
  return html`<button class="list-item line-group ${selected ? "is-selected" : ""}" data-act="target" data-id="${g.id}" ${g.joined ? "" : "disabled"} aria-pressed="${selected}">
    <span class="avatar avatar-md line-group-avatar"${avatarStyle}>${String(avatarStyle) ? "" : "👥"}</span>
    <span class="list-main">
      <span class="list-title ellipsis" style="display:block">${name}</span>
      <span class="list-sub" style="display:block">${g.joined ? `最終確認 ${ago(g.lastSeenAt)}` : "公式アカウントが退出しました"}</span>
    </span>
    <span class="line-radio" aria-hidden="true"></span>
  </button>`;
}

function kindRow(k, value) {
  if (k.options) {
    return html`<div class="line-kind line-kind-choice">
      <div class="grow"><p class="strong">${k.label}</p><p class="small muted">${k.desc}</p></div>
      <div class="segmented line-seg" data-kind="${k.key}">
        ${k.options.map(([v, label]) => html`<button type="button" class="${value === v ? "active" : ""}" data-act="choice" data-value="${v}">${label}</button>`)}
      </div>
    </div>`;
  }
  return html`<label class="line-kind">
    <div class="grow">
      <p class="strong">${k.label}${k.time ? html` <span class="chip line-time">${k.time}</span>` : ""}</p>
      <p class="small muted">${k.desc}</p>
    </div>
    <span class="line-switch"><input type="checkbox" role="switch" data-kind="${k.key}" ${value ? "checked" : ""} aria-label="${k.label}" /><i></i></span>
  </label>`;
}

function adminView(view, s) {
  const webhookUrl = s.webhookUrl || `${location.origin}${WEBHOOK_PATH}`;
  const { items, done, total } = checklist(s);
  const pct = Math.round((done / total) * 100);
  const groupsByKind = [...new Set(s.kinds.map((k) => k.group))];
  const canTest = s.configured.token && s.target?.joined;

  mount(
    view,
    html`<section class="card card-hero line-hero ${s.ready ? "is-ready" : ""}">
        <div class="row gap">
          <div class="line-ring" style="--p:${pct}">
            <span class="line-logo">${lineIcon}</span>
          </div>
          <div class="grow">
            <p class="small muted">${s.ready ? "グループに自動でお届け中" : "セットアップ"}</p>
            <p class="line-hero-title">${s.ready ? "LINE通知 稼働中" : `あと${total - done}ステップ`}</p>
            <p class="small"><span class="num line-count">${done}</span><span class="muted"> / ${total} 完了</span></p>
          </div>
          ${s.ready ? html`<span class="chip chip-green line-live"><i></i>ON</span>` : ""}
        </div>
        <ul class="line-check">
          ${items.map(
            ([ok, t, d]) => html`<li class="${ok ? "ok" : ""}">
              <span class="line-check-mark">${ok ? "✓" : ""}</span>
              <div class="grow"><p class="strong">${t}</p><p class="small muted">${d}</p></div>
            </li>`,
          )}
        </ul>
        ${s.configured.liff ? "" : html`<p class="hint">LIFF_ID が未設定のため、通知に「アプリで開く」ボタンが付きません</p>`}
        <div class="line-webhook">
          <p class="small muted">Webhook URL（LINE Developers に設定）</p>
          <div class="row gap">
            <code class="line-url grow">${webhookUrl}</code>
            <button class="btn btn-sm" data-act="copy" data-text="${webhookUrl}">コピー</button>
          </div>
        </div>
      </section>

      <p class="section-title">通知先グループ <button class="btn btn-ghost btn-sm" data-act="reload">更新</button></p>
      ${s.groups.length
        ? html`<div class="list">${s.groups.map((g) => groupItem(g, g.id === s.target?.id))}</div>
            <p class="hint">グループが見つからないときは、グループで「ヘルプ」と送ってから更新してください</p>`
        : html`<div class="card card-flat line-empty">
            <p class="line-empty-icon">👥</p>
            <p class="strong">まだグループが記録されていません</p>
            <p class="small muted">公式アカウントをチームのLINEグループに招待すると、ここに表示されます</p>
          </div>`}

      ${groupsByKind.map(
        (gname) => html`<p class="section-title">${gname}</p>
          <div class="card line-kinds">${s.kinds.filter((k) => k.group === gname).map((k) => kindRow(k, s.notify[k.key]))}</div>`,
      )}

      <p class="section-title">グループで使えるコマンド</p>
      <div class="card">${commandList()}</div>

      ${s.log.length
        ? html`<p class="section-title">最近の送信</p>
            <div class="list">
              ${s.log.map(
                (l) => html`<div class="list-item">
                  <span class="line-log-dot ${l.ok ? "ok" : "ng"}"></span>
                  <div class="list-main">
                    <p class="list-title ellipsis">${l.title}</p>
                    <p class="list-sub">${KIND_LABEL[l.kind] || l.kind} ・ ${ago(l.at)}${l.ok ? "" : ` ・ 失敗（${l.detail || "不明"}）`}</p>
                  </div>
                </div>`,
              )}
            </div>`
        : ""}

      <div class="line-actions">
        <button class="btn btn-line btn-block" data-act="test" ${canTest ? "" : "disabled"}>${lineIcon} テスト送信</button>
        <button class="btn btn-ghost btn-block" data-act="guide">📘 セットアップ手順を見る</button>
      </div>`,
  );
}

async function renderLine(view) {
  setHeader({ title: "LINE通知", back: "/more" });
  if (!isAdmin()) return memberView(view);

  let s = await get("/line/status");
  const draw = () => adminView(view, s);
  draw();

  const save = async (body) => {
    s = await patch("/line/settings", body);
    return s;
  };

  const offs = [
    on(view, "change", "input[data-kind]", async (e, input) => {
      const key = input.dataset.kind;
      const val = input.checked;
      try {
        await save({ notify: { [key]: val } });
        navigator.vibrate?.(5);
        toast(`${s.kinds.find((k) => k.key === key)?.label}を${val ? "オン" : "オフ"}にしました`, { type: "success", ms: 1600 });
      } catch (err) {
        input.checked = !val;
        toastError(err);
      }
    }),
    on(view, "click", "[data-act=choice]", async (e, btn) => {
      const seg = btn.closest("[data-kind]");
      const prev = seg.querySelector(".active");
      if (prev === btn) return;
      prev?.classList.remove("active");
      btn.classList.add("active");
      try {
        await save({ notify: { [seg.dataset.kind]: btn.dataset.value } });
        toast(`お知らせ: ${btn.textContent}`, { type: "success", ms: 1600 });
      } catch (err) {
        btn.classList.remove("active");
        prev?.classList.add("active");
        toastError(err);
      }
    }),
    on(view, "click", "[data-act=target]", (e, btn) => {
      if (btn.dataset.id === s.target?.id) return;
      busy(btn, async () => {
        await save({ targetGroupId: btn.dataset.id });
        draw();
        toast("通知先を変更しました。テスト送信で確認しましょう", { type: "success" });
      });
    }),
    on(view, "click", "[data-act=reload]", (e, btn) =>
      busy(btn, async () => {
        s = await get("/line/status");
        draw();
      }),
    ),
    on(view, "click", "[data-act=copy]", (e, btn) => copyText(btn.dataset.text)),
    on(view, "click", "[data-act=test]", (e, btn) =>
      busy(btn, async () => {
        try {
          await post("/line/test");
          toast("送信しました！LINEグループを確認してください", { type: "success" });
        } finally {
          // 失敗しても送信履歴（失敗理由）を表示する
          s = await get("/line/status").catch(() => s);
          draw();
        }
      }),
    ),
    on(view, "click", "[data-act=guide]", () =>
      sheet({ title: "LINE通知のセットアップ", body: setupSteps(s.webhookUrl || `${location.origin}${WEBHOOK_PATH}`) }),
    ),
  ];
  return () => offs.forEach((f) => f());
}

export default {
  name: "line",
  routes: { "/line": renderLine },
  homeCards: [],
  menu: [{ path: "/line", label: "LINE通知", icon: "🔔", order: 90 }],
};
