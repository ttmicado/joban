// LINE 公式アカウント（Messaging API）連携: グループへの自動通知・リマインド・トークのコマンド応答
//
// 環境変数（Vercel の Environment Variables）
//   LINE_MESSAGING_TOKEN  チャネルアクセストークン（push / reply / グループ名取得）
//   LINE_MESSAGING_SECRET チャネルシークレット（webhook の署名検証）
//   LIFF_ID               「アプリで開く」ボタンのリンク先（https://liff.line.me/<LIFF_ID>/#/...）
// どれも未設定なら何もしない（エラーにしない）。
//
// 設定は settings テーブルの key "line" に { targetGroupId, notify: { <種類>: true/false, notice: "off|important|all" } }。
import { raw } from "../app.js";
import { ApiError, badRequest } from "../errors.js";
import { addDays, toTs } from "../time.js";
import { battingRates } from "../../../public/app/lib/stats.js";
import {
  eventBubble,
  eventTypeLabel,
  flexMessage,
  fmtDay,
  listBubble,
  names,
  resultBubble,
  simpleBubble,
  clip,
} from "../../../public/app/lib/flex.js";
import { describeError, groupSummary, hasToken, push, reply } from "../line/client.js";
import { verifySignature } from "../line/signature.js";

// ---------------------------------------------------------------- 通知の種類
export const KINDS = [
  { key: "eventCreated", group: "予定・試合", label: "新しい予定", desc: "予定が追加されたとき" },
  { key: "eventChanged", group: "予定・試合", label: "予定の変更・中止", desc: "日付・集合時間・球場が変わったとき／中止になったとき" },
  { key: "poll", group: "予定・試合", label: "日程調整の開始・決定", desc: "候補日の募集が始まったとき／日程が決まったとき" },
  { key: "gameResult", group: "予定・試合", label: "試合結果", desc: "スコアが確定したとき（スコアボード付き）" },
  {
    key: "notice",
    group: "チーム",
    label: "お知らせ",
    desc: "連絡事項が投稿されたとき",
    options: [
      ["off", "オフ"],
      ["important", "重要のみ"],
      ["all", "すべて"],
    ],
  },
  { key: "memberJoined", group: "チーム", label: "新メンバー", desc: "新しい仲間がアプリに参加したとき" },
  { key: "remindEve", group: "自動リマインド", label: "前日リマインド", desc: "前日 20:00 に集合時間・球場・持ち物・未回答者", time: "前日 20:00" },
  { key: "wakeup", group: "自動リマインド", label: "当日の起床チェック", desc: "集合の90分前に、起床報告がない出席者へ「起きてますか？」", time: "集合90分前" },
  { key: "rsvpDeadline", group: "自動リマインド", label: "出欠締切リマインド", desc: "締切の前日 20:00 に未回答者の名前", time: "締切前日 20:00" },
  { key: "statsInput", group: "自動リマインド", label: "成績入力リマインド", desc: "試合の翌日 20:00 に成績が未入力の選手の名前", time: "試合翌日 20:00" },
];

export const DEFAULT_NOTIFY = Object.fromEntries(KINDS.map((k) => [k.key, k.options ? "important" : true]));

const REMIND_TIME = "20:00";
const WAKE_BEFORE_MIN = 90;

export function lineConfig(c) {
  const s = c.settings.line || {};
  return { targetGroupId: s.targetGroupId || null, notify: { ...DEFAULT_NOTIFY, ...(s.notify || {}) } };
}

const appLink = (c, path = "/") => (c.env.LIFF_ID ? `https://liff.line.me/${c.env.LIFF_ID}/#${path}` : null);
const appTop = (c) => (c.env.LIFF_ID ? `https://liff.line.me/${c.env.LIFF_ID}` : null);

// 通知を送れる状態か（トークン・通知先・種類のオン）
function canSend(c, kind) {
  const cfg = lineConfig(c);
  if (!hasToken(c.env) || !cfg.targetGroupId) return false;
  if (!kind) return true;
  const val = cfg.notify[kind];
  return val === true || (typeof val === "string" && val !== "off");
}

// 通知先グループへ push して送信履歴に残す
async function send(c, kind, title, messages) {
  const cfg = lineConfig(c);
  if (!hasToken(c.env) || !cfg.targetGroupId) return false;
  let r;
  try {
    r = await push(c.env, cfg.targetGroupId, messages);
  } catch (err) {
    r = { ok: false, status: 0, data: { message: err?.message || "network error" } };
  }
  const detail = r.ok ? null : describeError(r);
  await c.db.run("INSERT INTO line_log(kind, title, ok, detail, at) VALUES(?, ?, ?, ?, ?)", kind, clip(title, 100), r.ok ? 1 : 0, detail, c.now.ts);
  await c.db.run("DELETE FROM line_log WHERE id NOT IN (SELECT id FROM line_log ORDER BY id DESC LIMIT 50)");
  if (!r.ok) c.log.error?.(`[line] push failed (${kind}): ${detail}`);
  return r.ok;
}

// ---------------------------------------------------------------- 集計ヘルパー
const memberName = async (c, id) => (id ? (await c.db.one("SELECT name FROM members WHERE id = ?", id))?.name || null : null);

async function attendanceSummary(c, eventId) {
  const roster = await c.db.all("SELECT id, name FROM members WHERE active = 1 AND is_guest = 0 ORDER BY id");
  const rows = await c.db.all(
    `SELECT a.member_id, a.status, m.name FROM attendance a JOIN members m ON m.id = a.member_id
     WHERE a.event_id = ? AND m.active = 1 ORDER BY a.updated_at, a.member_id`,
    eventId,
  );
  const by = { yes: [], maybe: [], no: [] };
  for (const r of rows) by[r.status]?.push(r.name);
  const answered = new Set(rows.map((r) => r.member_id));
  const unanswered = roster.filter((m) => !answered.has(m.id)).map((m) => m.name);
  return { yes: by.yes.length, maybe: by.maybe.length, no: by.no.length, yesNames: by.yes, maybeNames: by.maybe, noNames: by.no, unanswered };
}

async function nextEvent(c) {
  return c.db.one(
    `SELECT * FROM events WHERE status = 'scheduled' AND date >= ?
     ORDER BY date, COALESCE(meet_time, start_time, '99:99'), id LIMIT 1`,
    c.now.date,
  );
}

// to_regclass は存在しなければ NULL を返す（例外にならないのでトランザクションを壊さない）
async function tableExists(c, name) {
  const row = await c.db.one("SELECT to_regclass(?) IS NOT NULL AS ok", name);
  return !!row?.ok;
}

const fmtAvg = (v) => (v === null ? "-" : v >= 1 ? v.toFixed(3) : v.toFixed(3).slice(1));

async function battingLeaders(c) {
  const season = Number(c.settings.season);
  const teamGames = (await c.db.one("SELECT COUNT(*) AS n FROM games WHERE season = ? AND status = 'final'", season)).n;
  const rows = await c.db.all(
    `SELECT b.member_id, m.name, COUNT(*) AS games, SUM(b.pa) AS pa, SUM(b.ab) AS ab, SUM(b.h) AS h, SUM(b.d2) AS d2, SUM(b.d3) AS d3,
            SUM(b.hr) AS hr, SUM(b.rbi) AS rbi, SUM(b.bb) AS bb, SUM(b.hbp) AS hbp, SUM(b.sf) AS sf, SUM(b.sb) AS sb
     FROM batting b JOIN games g ON g.id = b.game_id JOIN members m ON m.id = b.member_id
     WHERE g.season = ? AND g.status = 'final'
     GROUP BY b.member_id, m.name`,
    season,
  );
  const withRates = rows.map((r) => ({ ...r, ...battingRates(r) }));
  const qualified = withRates.filter((r) => r.ab > 0 && r.pa >= Math.max(1, teamGames));
  const top = (list, key, fmt, { min = 1 } = {}) =>
    list
      .filter((r) => r[key] !== null && r[key] >= min)
      .sort((a, b) => b[key] - a[key] || b.pa - a.pa)
      .slice(0, 3)
      .map((r) => [r.name, fmt(r[key])]);
  return {
    season,
    teamGames,
    avg: top(qualified, "avg", fmtAvg, { min: 0 }),
    hr: top(withRates, "hr", (n) => `${n}本`),
    rbi: top(withRates, "rbi", (n) => `${n}点`),
    h: top(withRates, "h", (n) => `${n}本`),
    sb: top(withRates, "sb", (n) => `${n}個`),
  };
}

// ---------------------------------------------------------------- メッセージ
function eventMessage(c, event, opts = {}) {
  const label = opts.label || `${eventTypeLabel(event.type)}のお知らせ`;
  const alt = `【${label}】${fmtDay(event.date)} ${event.title}${event.meet_time ? ` 集合${event.meet_time}` : ""}${event.venue ? ` ${event.venue}` : ""}`;
  return flexMessage(alt, eventBubble(event, { url: appLink(c, `/schedule/${event.id}`), ...opts, label }));
}

function helpMessage(c) {
  const url = appTop(c);
  return flexMessage(
    "使えるコマンド: 次の予定 / 出欠 / ランキング / ヘルプ",
    listBubble({
      label: "HELP",
      title: "使えるコマンド",
      sub: "このグループで送ると返事します",
      sections: [
        {
          heading: "コマンド",
          lines: ["「次の予定」… 次の予定の日時・集合・球場", "「出欠」… 次の予定の出欠状況", "「ランキング」… 今季の打撃ランキング", "「ヘルプ」… この一覧"],
        },
        { heading: "アプリ", lines: [url ? `出欠の回答や成績入力はアプリから\n${url}` : "出欠の回答や成績入力はアプリから"] },
      ],
      url,
      buttonLabel: "アプリを開く",
    }),
  );
}

async function attendanceMessage(c, event) {
  const a = await attendanceSummary(c, event.id);
  return flexMessage(
    `【出欠】${fmtDay(event.date)} ${event.title} 出席${a.yes} 未定${a.maybe} 欠席${a.no} 未回答${a.unanswered.length}`,
    listBubble({
      label: "出欠状況",
      title: event.title,
      sub: [fmtDay(event.date), event.meet_time ? `集合 ${event.meet_time}` : "", event.venue || ""].filter(Boolean).join("  "),
      sections: [
        { heading: `出席 ${a.yes}人`, color: "#128a52", lines: a.yesNames.length ? [names(a.yesNames, { max: 30 })] : [], empty: "まだいません" },
        { heading: `未定 ${a.maybe}人`, color: "#b8860b", lines: a.maybeNames.length ? [names(a.maybeNames, { max: 30 })] : [] },
        { heading: `欠席 ${a.no}人`, color: "#ff5a5f", lines: a.noNames.length ? [names(a.noNames, { max: 30 })] : [] },
        { heading: `未回答 ${a.unanswered.length}人`, color: "#5f6f96", lines: a.unanswered.length ? [names(a.unanswered, { max: 30 })] : [] },
      ],
      url: appLink(c, `/schedule/${event.id}`),
      buttonLabel: "出欠を回答する",
    }),
  );
}

async function rankingMessage(c) {
  const r = await battingLeaders(c);
  const title = `${r.season}年 打撃ランキング`;
  if (!r.teamGames) {
    return flexMessage(title, simpleBubble({ label: "RANKING", title, body: "今季の確定した試合結果がまだありません。", url: appLink(c, "/stats") }));
  }
  const alt = `${title} 打率1位 ${r.avg[0]?.[0] || "-"} / 本塁打1位 ${r.hr[0]?.[0] || "-"}`;
  return flexMessage(
    alt,
    listBubble({
      label: "RANKING",
      title,
      sub: `${r.teamGames}試合消化・打率は規定打席（試合数）以上`,
      accent: "#ffc83d",
      sections: [
        { heading: "打率", rows: r.avg, empty: "規定打席に達した選手がいません" },
        { heading: "本塁打", rows: r.hr, empty: "まだ出ていません" },
        { heading: "打点", rows: r.rbi, empty: "まだありません" },
        { heading: "安打", rows: r.h, empty: "まだありません" },
        ...(r.sb.length ? [{ heading: "盗塁", rows: r.sb }] : []),
      ],
      url: appLink(c, "/stats"),
      buttonLabel: "成績をすべて見る",
    }),
  );
}

// ---------------------------------------------------------------- webhook
function sourceOf(ev) {
  const s = ev.source || {};
  if (s.type === "group" && s.groupId) return { id: s.groupId, type: "group" };
  if (s.type === "room" && s.roomId) return { id: s.roomId, type: "room" };
  return null;
}

async function recordGroup(c, src, { joined = true } = {}) {
  const row = await c.db.one("SELECT * FROM line_groups WHERE group_id = ?", src.id);
  if (row) {
    await c.db.run("UPDATE line_groups SET last_seen_at = ?, joined = ? WHERE group_id = ?", c.now.ts, joined ? 1 : 0, src.id);
  } else {
    await c.db.run(
      "INSERT INTO line_groups(group_id, type, joined, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?)",
      src.id,
      src.type,
      joined ? 1 : 0,
      c.now.ts,
      c.now.ts,
    );
  }
  // グループ名・アイコン（room には名前が無い）
  if (joined && src.type === "group" && !row?.name) {
    try {
      const sum = await groupSummary(c.env, src.id);
      if (sum?.groupName) {
        await c.db.run("UPDATE line_groups SET name = ?, picture = ? WHERE group_id = ?", clip(sum.groupName, 100), sum.pictureUrl || null, src.id);
      }
    } catch (err) {
      c.log.error?.("[line] group summary failed", err?.message);
    }
  }
}

const COMMANDS = [
  ["next", ["次の予定", "次", "予定", "つぎのよてい"]],
  ["attendance", ["出欠", "出欠状況", "出欠確認"]],
  ["ranking", ["ランキング", "成績", "打撃成績"]],
  ["help", ["ヘルプ", "help", "使い方", "コマンド"]],
];

export function parseCommand(input) {
  const t = String(input || "")
    .replace(/^@\S+\s+/, "") // 公式アカウントへのメンション
    .replace(/[\s　?？!！。]/g, "")
    .toLowerCase();
  for (const [cmd, words] of COMMANDS) if (words.includes(t)) return cmd;
  return null;
}

async function handleCommand(c, ev, src) {
  const cmd = parseCommand(ev.message?.text);
  if (!cmd) return; // コマンド以外の発言には反応しない
  const cfg = lineConfig(c);
  const isTarget = cfg.targetGroupId === src.id;
  let messages;
  if (!isTarget) {
    // 通知先以外のグループにはチームの情報を出さない
    if (cmd !== "help") return;
    messages = [
      {
        type: "text",
        text: "このグループはまだ通知先に設定されていません。\n管理者がアプリの「その他 → LINE通知」で、このグループを通知先に選ぶと使えるようになります。",
      },
    ];
  } else if (cmd === "help") {
    messages = [helpMessage(c)];
  } else if (cmd === "ranking") {
    messages = [await rankingMessage(c)];
  } else {
    const event = await nextEvent(c);
    if (!event) {
      messages = [{ type: "text", text: "予定はまだ登録されていません📅\nアプリの「日程」から追加できます。" }];
    } else if (cmd === "next") {
      const a = await attendanceSummary(c, event.id);
      messages = [eventMessage(c, event, { label: "次の予定", attendance: a, buttonLabel: "出欠を回答する" })];
    } else {
      messages = [await attendanceMessage(c, event)];
    }
  }
  const r = await reply(c.env, ev.replyToken, messages);
  if (!r.ok && !r.skipped) c.log.error?.(`[line] reply failed: ${describeError(r)}`);
}

async function webhook(c) {
  const secret = c.env.LINE_MESSAGING_SECRET;
  if (!secret) return { ok: true, ignored: true }; // 連携していないときは静かに無視
  const sig = c.headers["x-line-signature"] || c.headers["X-Line-Signature"] || "";
  if (!(await verifySignature(secret, c.rawBody, sig))) throw new ApiError(401, "bad_signature", "署名が不正です");

  const events = Array.isArray(c.body?.events) ? c.body.events : [];
  for (const ev of events) {
    const src = sourceOf(ev);
    if (!src) continue; // 1対1のトークなどは扱わない
    try {
      // イベントごとに SAVEPOINT で区切り、1件の失敗で他のイベントの記録を巻き込まない
      await c.db.savepoint(async () => {
        if (ev.type === "leave") {
          await recordGroup(c, src, { joined: false });
          return;
        }
        await recordGroup(c, src);
        if (ev.type === "join") {
          const cfg = lineConfig(c);
          const text =
            cfg.targetGroupId === src.id
              ? "ただいま！このグループに通知をお届けします⚾"
              : "招待ありがとうございます⚾\n管理者はアプリの「その他 → LINE通知」で、このグループを通知先に選んでください。\n予定・試合結果・リマインドが自動で届くようになります。";
          await reply(c.env, ev.replyToken, [{ type: "text", text }]);
        } else if (ev.type === "message" && ev.message?.type === "text") {
          await handleCommand(c, ev, src);
        }
      });
    } catch (err) {
      c.log.error?.("[line] webhook event failed", err?.message);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 設定 API
async function status(c) {
  const cfg = lineConfig(c);
  const groups = (await c.db.all("SELECT * FROM line_groups ORDER BY joined DESC, last_seen_at DESC")).map((g) => ({ id: g.group_id, type: g.type, name: g.name || "", picture: g.picture || "", joined: !!g.joined, firstSeenAt: g.first_seen_at, lastSeenAt: g.last_seen_at }));
  const target = groups.find((g) => g.id === cfg.targetGroupId) || null;
  const host = c.headers?.host || c.headers?.Host || "";
  return {
    configured: {
      token: hasToken(c.env),
      secret: !!c.env.LINE_MESSAGING_SECRET,
      liff: !!c.env.LIFF_ID,
    },
    ready: hasToken(c.env) && !!c.env.LINE_MESSAGING_SECRET && !!target && target.joined,
    target,
    groups,
    notify: cfg.notify,
    kinds: KINDS,
    webhookPath: "/api/line/webhook",
    webhookUrl: host ? `https://${host}/api/line/webhook` : null,
    log: (await c.db.all("SELECT kind, title, ok, detail, at FROM line_log ORDER BY id DESC LIMIT 10")).map((r) => ({ ...r, ok: !!r.ok })),
  };
}

async function updateSettings(c) {
  const cur = lineConfig(c);
  const b = c.body || {};
  const next = { targetGroupId: cur.targetGroupId, notify: { ...cur.notify } };
  if (b.targetGroupId !== undefined) {
    if (b.targetGroupId === null || b.targetGroupId === "") next.targetGroupId = null;
    else {
      const g = await c.db.one("SELECT group_id FROM line_groups WHERE group_id = ?", String(b.targetGroupId));
      if (!g) throw badRequest("そのグループは記録されていません。公式アカウントをグループに招待してください");
      next.targetGroupId = g.group_id;
    }
  }
  if (b.notify !== undefined) {
    if (!b.notify || typeof b.notify !== "object") throw badRequest("通知設定の形式が不正です");
    for (const [k, val] of Object.entries(b.notify)) {
      const kind = KINDS.find((x) => x.key === k);
      if (!kind) throw badRequest("通知の種類が不正です");
      if (kind.options) {
        if (!kind.options.some(([o]) => o === val)) throw badRequest(`${kind.label}の値が不正です`);
        next.notify[k] = val;
      } else {
        if (typeof val !== "boolean") throw badRequest(`${kind.label}の値が不正です`);
        next.notify[k] = val;
      }
    }
  }
  await c.saveSettings({ line: next });
  return status(c);
}

async function sendTest(c) {
  if (!hasToken(c.env)) throw badRequest("チャネルアクセストークン（LINE_MESSAGING_TOKEN）が設定されていません");
  const cfg = lineConfig(c);
  if (!cfg.targetGroupId) throw badRequest("通知先のグループを選んでください");
  const ok = await send(c, "test", "テスト送信", [
    flexMessage(
      "テスト送信：LINE通知の設定ができました",
      simpleBubble({
        label: "TEST",
        title: "通知テスト⚾",
        body: `${c.settings.teamName}のアプリから送信しました。\nこのグループに予定・試合結果・リマインドが届きます。\n「ヘルプ」と送るとコマンド一覧を返します。`,
        rows: [["送信者", c.member?.name]],
        url: appTop(c),
        buttonLabel: "アプリを開く",
      }),
    ),
  ]);
  if (!ok) {
    // 例外にするとトランザクションごとロールバックされ送信履歴（失敗）が残らないので、エラー応答を返してコミットする
    return raw(JSON.stringify({ error: "line_failed", message: "LINEへの送信に失敗しました。トークンと、公式アカウントがグループにいるかを確認してください" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------- イベント購読
const CHANGE_FIELDS = [
  ["date", "日付", (v) => fmtDay(v)],
  ["end_date", "最終日", (v) => (v ? fmtDay(v) : "なし")],
  ["meet_time", "集合", (v) => v],
  ["meet_place", "集合場所", (v) => v],
  ["start_time", "開始", (v) => v],
  ["venue", "球場", (v) => v],
];

async function onEventCreated(c, { event }) {
  if (!event || event.status === "canceled" || !canSend(c, "eventCreated")) return;
  if (event.date && event.date < c.now.date) return; // 過去の記録用の予定は流さない
  await c.once(`line:event:${event.id}`, () =>
    send(c, "eventCreated", `新しい予定: ${event.title}`, [eventMessage(c, event, { label: `新しい${eventTypeLabel(event.type)}`, buttonLabel: "出欠を回答する" })]),
  );
}

async function onEventCanceled(c, { event }) {
  if (!event || !canSend(c, "eventChanged")) return;
  if (event.date && event.date < c.now.date) return;
  await c.once(`line:cancel:${event.id}:${event.updated_at ?? ""}`, () =>
    send(c, "eventChanged", `中止: ${event.title}`, [eventMessage(c, { ...event, status: "canceled" }, { label: "中止のお知らせ", canceled: true })]),
  );
}

async function onEventUpdated(c, { event, before }) {
  if (!event || !before) return;
  if (event.status === "canceled" && before.status !== "canceled") return onEventCanceled(c, { event });
  if (!canSend(c, "eventChanged")) return;
  if (event.date && event.date < c.now.date) return;
  if (event.status !== "canceled" && before.status === "canceled") {
    return void (await send(c, "eventChanged", `再開: ${event.title}`, [eventMessage(c, event, { label: "中止から再開", accent: "#ffc83d" })]));
  }
  if (event.status === "canceled") return;
  const changes = CHANGE_FIELDS.filter(([k]) => (before[k] || null) !== (event[k] || null)).map(([k, label, f]) => [label, before[k] ? f(before[k]) : "", event[k] ? f(event[k]) : ""]);
  if (!changes.length) return; // メモなど重要でない変更は流さない
  await send(c, "eventChanged", `変更: ${event.title}`, [
    eventMessage(c, event, { label: "予定の変更", accent: "#ffc83d", changes }),
  ]);
}

async function onPollCreated(c, { poll, options = [] }) {
  if (!poll || !canSend(c, "poll")) return;
  const lines = options.slice(0, 10).map((o) => {
    const label = [o.date ? fmtDay(o.date) : "", o.time || o.start_time || "", o.note || o.label || o.title || ""].filter(Boolean).join(" ");
    return `・${label || "候補"}`;
  });
  if (options.length > 10) lines.push(`ほか${options.length - 10}件`);
  await c.once(`line:poll:${poll.id}`, () =>
    send(c, "poll", `日程調整: ${poll.title}`, [
      flexMessage(
        `【日程調整】${poll.title} の候補日に回答してください`,
        listBubble({
          label: "日程調整",
          title: poll.title || "日程調整",
          sub: poll.deadline ? `回答締切 ${fmtDay(poll.deadline)}` : "都合のいい日を教えてください",
          accent: "#a78bfa",
          body: poll.note || poll.description || "",
          sections: [{ heading: `候補 ${options.length}件`, lines }],
          url: appLink(c, `/polls/${poll.id}`),
          buttonLabel: "回答する",
        }),
      ),
    ]),
  );
}

async function onPollDecided(c, { poll, event }) {
  if (!event || !canSend(c, "poll")) return;
  await c.once(`line:poll-decided:${poll?.id ?? "x"}:${event.id}`, () =>
    send(c, "poll", `日程決定: ${event.title}`, [
      eventMessage(c, event, { label: "日程が決まりました！", accent: "#a78bfa", note: poll?.title ? `「${poll.title}」の結果で決定しました` : "", buttonLabel: "出欠を回答する" }),
    ]),
  );
}

async function gameHighlights(c, game) {
  const out = [];
  const rows = await c.db.all(
    `SELECT b.*, m.name FROM batting b JOIN members m ON m.id = b.member_id WHERE b.game_id = ?
     ORDER BY b.hr DESC, b.h DESC, b.rbi DESC LIMIT 20`,
    game.id,
  );
  for (const b of rows) {
    const parts = [];
    if (b.h >= 2) parts.push(`${b.h}安打`);
    if (b.hr > 0) parts.push(`${b.hr}本塁打`);
    if (b.rbi >= 2) parts.push(`${b.rbi}打点`);
    if (parts.length) out.push(`${b.name} ${parts.join(" ")}`);
    if (out.length >= 3) break;
  }
  const win = await c.db.one("SELECT m.name FROM pitching p JOIN members m ON m.id = p.member_id WHERE p.game_id = ? AND p.decision = 'W' ORDER BY p.order_no NULLS FIRST, p.member_id LIMIT 1", game.id);
  if (win) out.push(`勝利投手 ${win.name}`);
  return out;
}

async function onGameFinalized(c, { game }) {
  if (!game || !canSend(c, "gameResult")) return;
  const us = Number(game.our_score ?? 0);
  const them = Number(game.their_score ?? 0);
  const res = us > them ? "勝利" : us < them ? "敗戦" : "引き分け";
  await c.once(`line:game:${game.id}`, async () =>
    send(c, "gameResult", `試合結果: vs ${game.opponent} ${us}-${them}`, [
      flexMessage(
        `【試合結果】vs ${game.opponent} ${us}-${them} で${res}${us > them ? "！" : ""}`,
        resultBubble(game, {
          teamName: c.settings.teamName,
          url: appLink(c, `/games/${game.id}`),
          mvp: await memberName(c, game.mvp_member_id),
          highlights: await gameHighlights(c, game),
        }),
      ),
    ]),
  );
}

function isImportant(n) {
  return !!(n.category === "important" || n.important || n.is_important || n.pinned || ["high", "important"].includes(n.priority) || n.level === "important");
}

async function onNoticeCreated(c, { notice, author }) {
  if (!notice || !canSend(c)) return;
  const mode = lineConfig(c).notify.notice;
  if (mode === "off" || (mode === "important" && !isImportant(notice))) return;
  const important = isImportant(notice);
  await c.once(`line:notice:${notice.id}`, () =>
    send(c, "notice", `お知らせ: ${notice.title || ""}`, [
      flexMessage(
        `【${important ? "重要なお知らせ" : "お知らせ"}】${notice.title || clip(notice.body, 40)}`,
        simpleBubble({
          label: important ? "重要なお知らせ" : "お知らせ",
          accent: important ? "#ff5a5f" : "#4da3ff",
          title: notice.title || "お知らせ",
          sub: author?.name ? `${author.name} さんより` : "",
          body: clip(notice.body || "", 400),
          url: appLink(c, `/notices/${notice.id}`),
          buttonLabel: "全文を読む",
        }),
      ),
    ]),
  );
}

async function onMemberJoined(c, { member }) {
  if (!member || !canSend(c, "memberJoined")) return;
  await c.once(`line:member:${member.id}`, () =>
    send(c, "memberJoined", `新メンバー: ${member.name}`, [
      flexMessage(
        `新しい仲間が加わりました！ ${member.name}さん`,
        simpleBubble({
          label: "NEW MEMBER",
          accent: "#ffc83d",
          title: `${member.name} さん`,
          sub: "新しい仲間が加わりました！",
          rows: [
            ["背番号", member.number || null],
            ["守備", member.positions?.length ? member.positions.join("・") : null],
          ],
          body: "みんなで歓迎しましょう⚾",
          url: appLink(c, `/players/${member.id}`),
          buttonLabel: "プロフィールを見る",
        }),
      ),
    ]),
  );
}

// ---------------------------------------------------------------- cron
async function remindEve(c) {
  if (c.now.time < REMIND_TIME || !canSend(c, "remindEve")) return;
  const tomorrow = addDays(c.now.date, 1);
  for (const event of await c.db.all("SELECT * FROM events WHERE date = ? AND status = 'scheduled' ORDER BY meet_time NULLS FIRST, id", tomorrow)) {
    await c.once(`line:eve:${event.id}:${event.date}`, async () => {
      const a = await attendanceSummary(c, event.id);
      return send(c, "remindEve", `前日リマインド: ${event.title}`, [
        eventMessage(c, event, {
          label: `明日は${eventTypeLabel(event.type)}です！`,
          accent: "#ffc83d",
          attendance: a,
          note: a.unanswered.length ? "未回答の人は今夜中に回答をお願いします🙏" : "全員回答済み！明日もがんばりましょう🔥",
          buttonLabel: "出欠を確認する",
        }),
      ]);
    });
  }
}

async function wakeupCheck(c) {
  if (!canSend(c, "wakeup")) return;
  if (!(await tableExists(c, "wakeups"))) return; // community 機能がまだ無いときはスキップ
  // 集合が 0:00〜1:29 の予定は、90分前のチェックが前日になるので翌日の予定も見る
  const days = [c.now.date, addDays(c.now.date, 1)];
  for (const event of await c.db.all("SELECT * FROM events WHERE date IN (?, ?) AND status = 'scheduled' ORDER BY date, id", ...days)) {
    const meet = event.meet_time || event.start_time;
    if (!meet) continue;
    const meetTs = toTs(event.date, meet);
    if (c.now.ts < meetTs - WAKE_BEFORE_MIN * 60000 || c.now.ts >= meetTs) continue;
    await c.once(`line:wake:${event.id}:${event.date}`, async () => {
      const sleepers = await c.db.all(
        `SELECT m.name FROM attendance a JOIN members m ON m.id = a.member_id
         WHERE a.event_id = ? AND a.status = 'yes' AND m.active = 1
           AND NOT EXISTS (SELECT 1 FROM wakeups w WHERE w.event_id = a.event_id AND w.member_id = a.member_id)
         ORDER BY m.id`,
        event.id,
      );
      if (!sleepers.length) return;
      const list = sleepers.map((s) => s.name);
      await send(c, "wakeup", `起床チェック: ${event.title}`, [
        flexMessage(
          `【起床チェック】${names(list)} さん、起きてますか？ 集合は${meet}です`,
          listBubble({
            label: "おはようございます☀️",
            accent: "#ffc83d",
            title: "起きてますか？",
            sub: `${event.title}  集合 ${meet}${event.venue ? `  ${event.venue}` : ""}`,
            sections: [{ heading: `起床報告がまだの人 ${list.length}人`, color: "#ff5a5f", lines: [names(list, { max: 30 })] }],
            body: "起きたらアプリで「起きた！」を押してください",
            url: appLink(c, "/wakeup"),
            buttonLabel: "起きた！を報告する",
          }),
        ),
      ]);
    });
  }
}

async function rsvpDeadlineRemind(c) {
  if (c.now.time < REMIND_TIME || !canSend(c, "rsvpDeadline")) return;
  const tomorrow = addDays(c.now.date, 1);
  const events = await c.db.all(
    "SELECT * FROM events WHERE rsvp_deadline = ? AND status = 'scheduled' AND date >= ? ORDER BY date, id",
    tomorrow,
    c.now.date,
  );
  for (const event of events) {
    await c.once(`line:deadline:${event.id}:${event.rsvp_deadline}`, async () => {
      const a = await attendanceSummary(c, event.id);
      if (!a.unanswered.length) return;
      await send(c, "rsvpDeadline", `出欠締切: ${event.title}`, [
        flexMessage(
          `【出欠締切は明日】${event.title} 未回答: ${names(a.unanswered)}`,
          listBubble({
            label: "出欠の締切は明日です",
            accent: "#ff5a5f",
            title: event.title,
            sub: `${fmtDay(event.date)}  締切 ${fmtDay(event.rsvp_deadline)}`,
            sections: [{ heading: `未回答 ${a.unanswered.length}人`, color: "#ff5a5f", lines: [names(a.unanswered, { max: 30 })] }],
            body: `現在 出席${a.yes}・未定${a.maybe}・欠席${a.no}`,
            url: appLink(c, `/schedule/${event.id}`),
            buttonLabel: "出欠を回答する",
          }),
        ),
      ]);
    });
  }
}

async function statsInputRemind(c) {
  if (c.now.time < REMIND_TIME || !canSend(c, "statsInput")) return;
  const yesterday = addDays(c.now.date, -1);
  for (const game of await c.db.all("SELECT * FROM games WHERE date = ? AND status = 'draft' ORDER BY id", yesterday)) {
    await c.once(`line:stats:${game.id}`, async () => {
      const rows = await c.db.all(
        `SELECT m.name FROM batting b JOIN members m ON m.id = b.member_id
         WHERE b.game_id = ? AND b.pa = 0 AND m.active = 1 AND COALESCE(b.position, '') != '控え'
           AND NOT EXISTS (SELECT 1 FROM pitching p WHERE p.game_id = b.game_id AND p.member_id = b.member_id)
         ORDER BY b.order_no NULLS FIRST, m.id`,
        game.id,
      );
      if (!rows.length) return;
      const list = rows.map((r) => r.name);
      await send(c, "statsInput", `成績入力: vs ${game.opponent}`, [
        flexMessage(
          `【成績入力のお願い】vs ${game.opponent} 未入力: ${names(list)}`,
          listBubble({
            label: "成績入力のお願い",
            accent: "#4da3ff",
            title: `${fmtDay(game.date)} vs ${game.opponent}`,
            sub: "昨日の試合の成績がまだ入力されていません",
            sections: [{ heading: `未入力 ${list.length}人`, color: "#4da3ff", lines: [names(list, { max: 30 })] }],
            body: "自分の打席結果を入力して、ランキングに反映させましょう📊",
            url: appLink(c, `/games/${game.id}`),
            buttonLabel: "成績を入力する",
          }),
        ),
      ]);
    });
  }
}

// ---------------------------------------------------------------- モジュール
export default {
  name: "line",
  migrations: [
    {
      id: "line-001",
      sql: `
CREATE TABLE IF NOT EXISTS line_groups (
  group_id TEXT PRIMARY KEY,             -- LINE の groupId / roomId
  type TEXT NOT NULL DEFAULT 'group',    -- group / room
  name TEXT,                             -- グループ名（GET /v2/bot/group/{id}/summary）
  picture TEXT,
  joined BIGINT NOT NULL DEFAULT 1,     -- 0: 公式アカウントが退出した
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

-- 送信履歴（直近50件）
CREATE TABLE IF NOT EXISTS line_log (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  ok BIGINT NOT NULL,
  detail TEXT,
  at BIGINT NOT NULL
);
`,
    },
  ],
  routes: [
    ["POST", "/line/webhook", webhook, { auth: "public" }],
    ["GET", "/line/status", status, { auth: "admin" }],
    ["PATCH", "/line/settings", updateSettings, { auth: "admin" }],
    ["POST", "/line/test", sendTest, { auth: "admin" }],
  ],
  on: {
    "event.created": onEventCreated,
    "event.updated": onEventUpdated,
    "event.canceled": onEventCanceled,
    "poll.created": onPollCreated,
    "poll.decided": onPollDecided,
    "game.finalized": onGameFinalized,
    "notice.created": onNoticeCreated,
    "member.joined": onMemberJoined,
  },
  async cron(c) {
    if (!hasToken(c.env) || !lineConfig(c).targetGroupId) return;
    for (const job of [remindEve, wakeupCheck, rsvpDeadlineRemind, statsInputRemind]) {
      try {
        await c.db.savepoint(() => job(c));
      } catch (err) {
        c.log.error?.(`[line] cron ${job.name} failed`, err?.message);
      }
    }
  },
};
