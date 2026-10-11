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
import { avatar, busy, celebrate, confirmDialog, empty, fab, memberLabel, readForm, sheet, toast } from "./ui.js";

import schedule from "./features/schedule.js";
import games from "./features/games.js";
import stats from "./features/stats.js";
import community from "./features/community.js";
import line from "./features/line.js";
import importer from "./features/importer.js";
import lives from "./features/lives.js";

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
    <div class="field"><label>守備位置（複数選択可）</label>${positionPills(m.positions || [])}</div>
    <div class="field"><label>役職（任意）</label><input class="input" name="title" maxlength="30" placeholder="例: キャプテン / 会計" value="${m.title || ""}" /></div>`;
}

// 役職のチップ（監督・キャプテンは目立つ色）。アプリの「管理者」権限とは別
function titleChip(m) {
  if (!m?.title) return "";
  const strong = /監督|(^|[^副])(キャプテン|主将)/.test(m.title);
  return html`<span class="chip chip-role ${strong ? "chip-red" : "chip-title"}">${m.title}</span>`;
}

// ---------------------------------------------------------------- 選手の紐付け（取り込んだ過去の選手 ↔ LINE）
// 名前の比較用: 全角半角・大文字小文字・空白の違いを無視
const normName = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　・.．_-]/g, "");

// LINE の表示名に近い順（部分一致 → 先頭2文字一致）に並べ、近いものに印を付ける
function rankCandidates(list, userName) {
  const me = normName(userName);
  const score = (c) => {
    const n = normName(c.name);
    if (!me || !n) return 0;
    if (n === me) return 3;
    if (n.includes(me) || me.includes(n)) return 2;
    if (n.length >= 2 && me.length >= 2 && (n.includes(me.slice(0, 2)) || me.includes(n.slice(0, 2)))) return 1;
    return 0;
  };
  return list
    .map((c, i) => ({ ...c, score: score(c), i }))
    .sort((a, b) => b.score - a.score || Number(a.retired) - Number(b.retired) || a.i - b.i);
}

const yearsLabel = (c) => (c.firstYear ? (c.firstYear === c.lastYear ? `${c.firstYear}年` : `${c.firstYear}〜${c.lastYear}年`) : "");

function candidateItem(c) {
  const sub = [c.positions.join("・"), c.games ? `${c.games}試合` : "成績なし", yearsLabel(c)].filter(Boolean).join(" / ");
  return html`<button type="button" class="list-item claim-item" data-act="pick" data-id="${c.id}" data-q="${normName(c.name)} ${c.number}">
    <span class="claim-uni num">${c.number || "-"}</span>
    <span class="list-main"><span class="list-title">${c.name}${titleChip(c)}</span><span class="list-sub" style="display:block">${sub}</span></span>
    ${c.score >= 2 ? html`<span class="chip chip-green">LINE名と一致</span>` : c.score === 1 ? html`<span class="chip chip-blue">似た名前</span>` : ""}
    ${c.retired ? html`<span class="chip">退団</span>` : ""}
    <span class="chev" aria-hidden="true">›</span>
  </button>`;
}

// 候補一覧（検索つき）。onPick(candidate)
function candidatePicker(root, list, { userName, onPick }) {
  const ranked = rankCandidates(list, userName);
  mount(
    root,
    html`<input class="input claim-search" type="search" placeholder="名前・背番号で検索" aria-label="選手を検索" data-claim-search />
      <div class="list claim-list" data-claim-list>${ranked.map(candidateItem)}</div>
      <p class="hint claim-none" data-claim-none hidden>見つかりません</p>`,
  );
  const input = root.querySelector("[data-claim-search]");
  input.addEventListener("input", () => {
    const q = normName(input.value);
    let shown = 0;
    for (const el of root.querySelectorAll("[data-act=pick]")) {
      const hit = !q || el.dataset.q.includes(q);
      el.hidden = !hit;
      if (hit) shown++;
    }
    root.querySelector("[data-claim-none]").hidden = shown > 0;
  });
  return on(root, "click", "[data-act=pick]", (_, el) => onPick(ranked.find((c) => c.id === Number(el.dataset.id))));
}

async function renderJoin(view) {
  setHeader({ title: "チームに参加" });
  let candidates = [];
  try {
    ({ candidates } = await get("/join/candidates"));
  } catch (err) {
    console.error(err);
  }
  const welcome = html`<div class="welcome">
    <div class="welcome-ball"></div>
    <h2>${state.settings?.teamName || "チーム"}へ<br />ようこそ！</h2>
    <p>LINEアカウントと紐づけて参加します。<br />日程・出欠・成績・連絡がここで完結します。</p>
  </div>`;
  const lineCard = html`<div class="row gap">${avatar({ name: state.user?.name, picture: state.user?.picture }, "lg")}<div><p class="strong">${state.user?.name}</p><p class="small muted">LINEアカウント</p></div></div>`;
  const firstChip = state.firstMember ? html`<p class="chip chip-amber">最初の参加者なので管理者（監督・マネージャー）になります</p>` : "";
  let off = null;

  const done = async (message) => {
    await refreshMe();
    celebrate();
    toast(message, { type: "success" });
    showChrome();
    navigate("/", { replace: true });
  };

  // 新しく登録（従来のフォーム）
  const showForm = () => {
    off?.();
    mount(
      view,
      html`${welcome}
        <form class="card form" id="join-form">
          ${lineCard}
          ${profileForm({ name: state.user?.name })}
          ${firstChip}
          <button class="btn btn-primary btn-block" type="submit">参加する</button>
        </form>
        ${candidates.length ? html`<button type="button" class="btn btn-ghost btn-block" data-act="back-pick">← 選手一覧から選ぶ</button>` : ""}`,
    );
    const form = $("#join-form", view);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(form.querySelector("[type=submit]"), async () => {
        await post("/join", readForm(form));
        await done("参加しました！よろしくお願いします");
      });
    });
    view.querySelector("[data-act=back-pick]")?.addEventListener("click", showPick);
    window.scrollTo(0, 0);
  };

  // 選んだ選手で参加する確認
  const confirmClaim = (c) =>
    sheet({
      title: "この選手で参加しますか？",
      body: html`<form class="form">
        <div class="claim-confirm">
          <span class="claim-uni claim-uni-lg num">${c.number || "-"}</span>
          <div><p class="strong">${c.name}</p><p class="small muted">${[c.positions.join("・"), yearsLabel(c)].filter(Boolean).join(" / ") || "　"}</p></div>
        </div>
        <p class="confirm-msg">${c.games ? `過去の成績 ${c.games} 試合分があなたの記録になります。` : "この選手としてLINEアカウントを紐付けます。"}${c.retired ? "（退団扱いから在籍に戻ります）" : ""}</p>
        <div class="field"><label>名前（チーム内での呼び名）</label><input class="input" name="name" maxlength="30" value="${c.name}" /></div>
        ${firstChip}
        <p class="hint">他の人を選んでしまったときは、管理者が連携を解除できます。</p>
        <button class="btn btn-primary btn-block" type="submit">${c.name} として参加する</button>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const { name } = readForm(form);
            await post("/join", { claimMemberId: c.id, name: name.trim() || c.name });
            close();
            await done(`${name.trim() || c.name} として参加しました！`);
          });
        });
      },
    });

  // 「あなたはどの選手ですか？」
  const showPick = () => {
    mount(
      view,
      html`<div class="claim-head">
          ${lineCard}
          <h2 class="claim-title">あなたはどの選手ですか？</h2>
          <p class="small muted">チームの過去の成績から選ぶと、これまでの記録があなたに引き継がれます。</p>
        </div>
        <div class="stack" data-picker></div>
        <button type="button" class="btn btn-block claim-new" data-act="new">リストにいない（新しく登録）</button>`,
    );
    off = candidatePicker(view.querySelector("[data-picker]"), candidates, { userName: state.user?.name, onPick: confirmClaim });
    view.querySelector("[data-act=new]").addEventListener("click", showForm);
  };

  if (candidates.length) showPick();
  else showForm();
  return () => off?.();
}

// 参加済みの人が、過去の成績データ（未連携の選手）を自分に統合する
async function renderLinkMe(view) {
  setHeader({ title: "過去の成績と紐付け", back: "/more" });
  const { candidates } = await get("/join/candidates");
  if (!candidates.length) {
    mount(view, empty("紐付けできる選手データはありません", { icon: "🔗" }));
    return;
  }
  const me = state.member;
  mount(
    view,
    html`<div class="card">
        <p class="strong">過去の成績データと紐付ける</p>
        <p class="small muted" style="margin-top:6px">以前の記録（取り込んだ過去の成績など）にあなたの選手がいれば選んでください。成績・出欠などがあなたの記録にまとまります。</p>
      </div>
      <div class="stack" data-picker></div>`,
  );
  const pick = (c) =>
    sheet({
      title: "紐付けの確認",
      body: html`<form class="form">
        <div class="claim-confirm">
          <span class="claim-uni claim-uni-lg num">${c.number || "-"}</span>
          <div><p class="strong">${c.name}</p><p class="small muted">${[c.positions.join("・"), yearsLabel(c)].filter(Boolean).join(" / ") || "　"}</p></div>
        </div>
        <p class="confirm-msg">${c.name} の成績 ${c.games} 試合分があなたの記録になります。<br />${c.name} のデータはあなた（${me.name}）にまとめられ、元の選手は一覧から消えます。</p>
        ${c.name !== me.name ? html`<label class="pill"><input type="checkbox" name="useName" /><span>名前を「${c.name}」に変える</span></label>` : ""}
        <div class="row gap">
          <button type="button" class="btn btn-ghost grow" data-sheet-close>キャンセル</button>
          <button type="submit" class="btn btn-primary grow">紐付ける</button>
        </div>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          busy(form.querySelector("[type=submit]"), async () => {
            const { useName } = readForm(form);
            await post("/me/merge", { memberId: c.id, useName: !!useName });
            close();
            await refreshMe();
            celebrate();
            toast("過去の成績を紐付けました", { type: "success" });
            navigate(`/players/${state.member.id}`, { replace: true });
          });
        });
      },
    });
  return candidatePicker(view.querySelector("[data-picker]"), candidates, { userName: me.name, onPick: pick });
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
        ${menuRow("#/me/link", "🔗", "過去の成績データと紐付ける")}
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
                <p class="list-title">${memberLabel(m)}${titleChip(m)}</p>
                <p class="list-sub">${[m.positions.join("・"), m.throws && m.bats ? `${m.throws}投${m.bats}打` : ""].filter(Boolean).join(" / ") || "　"}</p>
              </a>
              ${m.role === "admin" ? html`<span class="chip chip-amber">管理者</span>` : ""}
              ${m.isGuest ? html`<span class="chip chip-purple">助っ人</span>` : ""}
              ${!m.isGuest && !m.linked ? html`<span class="chip chip-blue">未連携</span>` : ""}
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
        ${m
          ? html`<div class="claim-admin">
              <p class="small muted">${m.linked ? "LINE連携済み" : "LINE未連携（本人がアプリで選ぶと連携されます）"}</p>
              <div class="row gap">
                ${m.linked && m.id !== state.member.id ? html`<button type="button" class="btn btn-sm grow" data-act="unlink">LINE連携を解除</button>` : ""}
                <button type="button" class="btn btn-sm grow" data-act="merge">別のメンバーに統合</button>
              </div>
            </div>`
          : ""}
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        const reload = async () => {
          ({ members } = await get("/members?all=1"));
          draw(members);
          await refreshMe();
        };
        el.querySelector("[data-act=unlink]")?.addEventListener("click", async (e) => {
          const ok = await confirmDialog(`${m.name} のLINE連携を解除します。成績はそのまま残り、本人（または正しい人）がもう一度選び直せます。`, { ok: "解除する", danger: true });
          if (!ok) return;
          busy(e.target, async () => {
            await patch(`/members/${m.id}`, { unlinkLine: true });
            close();
            toast("LINE連携を解除しました", { type: "success" });
            await reload();
          });
        });
        el.querySelector("[data-act=merge]")?.addEventListener("click", () => {
          close();
          openMerge(m, reload);
        });
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

  // m を別のメンバーに統合（成績・出欠などを移して m を削除）
  const openMerge = (m, reload) => {
    const targets = members.filter((t) => t.id !== m.id && !(t.linked && m.linked));
    sheet({
      title: `${m.name} を統合`,
      body: html`<form class="form">
        <p class="small muted">${m.name} の成績・出欠などをすべて統合先に移し、${m.name} は削除します。${m.linked ? "LINE連携も統合先に移ります。" : ""}</p>
        <div class="field"><label>統合先</label>
          <select class="select" name="intoId" required>
            <option value="">選んでください</option>
            ${targets.map((t) => html`<option value="${t.id}">${t.number ? `${t.number} ` : ""}${t.name}${t.linked ? "" : t.isGuest ? "（助っ人）" : "（未連携）"}${t.active ? "" : "（退団）"}</option>`)}
          </select>
        </div>
        ${m.linked ? "" : html`<p class="hint">LINE連携済みどうしは統合できません。先にどちらかの連携を解除してください。</p>`}
        <button class="btn btn-danger btn-block" type="submit">統合する</button>
      </form>`,
      onMount(el, close) {
        const form = el.querySelector("form");
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const intoId = Number(form.intoId.value);
          const into = members.find((t) => t.id === intoId);
          if (!into) return toast("統合先を選んでください", { type: "error" });
          busy(form.querySelector("[type=submit]"), async () => {
            const ok = await confirmDialog(`${m.name} を ${into.name} に統合します。元に戻せません。よろしいですか？`, { ok: "統合する", danger: true });
            if (!ok) return;
            await post(`/members/${m.id}/merge`, { intoId });
            close();
            toast(`${into.name} に統合しました`, { type: "success" });
            await reload();
          });
        });
      },
    });
  };

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
  for (const f of [schedule, games, stats, community, line, importer, lives]) registerFeature(f);
  addRoute("/", renderHome);
  addRoute("/join", renderJoin);
  addRoute("/more", renderMore);
  addRoute("/me/edit", renderEditMe);
  addRoute("/me/link", renderLinkMe);
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
