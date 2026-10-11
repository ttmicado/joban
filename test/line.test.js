import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { makeTeam } from "./helpers/team.js";
import members from "../src/team/features/members.js";
import line, { parseCommand } from "../src/team/features/line.js";
import { verifySignature } from "../src/team/line/signature.js";
import { features as allFeatures } from "../src/team/features/index.js";
import { eventBubble, flexMessage, resultBubble } from "../public/app/lib/flex.js";

const SECRET = "test-channel-secret";
const TOKEN = "test-access-token";
const ENV = { LINE_MESSAGING_TOKEN: TOKEN, LINE_MESSAGING_SECRET: SECRET, LIFF_ID: "2000000000-abcdEFGH" };
const GROUP = "Cgroup0000000000000000000000000001";

// 他機能（schedule など）に依存せずにイベントを発行するためのテスト用機能
const emitter = {
  name: "emitter",
  routes: [["POST", "/_emit", (c) => (c.emit(c.body.name, c.body.payload), { ok: true }), { auth: "public" }]],
};
const FEATURES = [members, line, emitter];

// ---------------------------------------------------------------- fetch モック
let calls = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body });
    if (String(url).includes("/summary")) {
      return new Response(JSON.stringify({ groupId: GROUP, groupName: "常磐ナイン連絡", pictureUrl: "https://example.com/g.png" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const pushes = () => calls.filter((c) => c.url.endsWith("/message/push"));
const replies = () => calls.filter((c) => c.url.endsWith("/message/reply"));
const json = (m) => JSON.stringify(m);

// ---------------------------------------------------------------- ヘルパー
const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");

async function hook(t, events, { secret = SECRET, signature } = {}) {
  const rawBody = JSON.stringify({ destination: "Ubot", events });
  const res = await t.app.handle({
    method: "POST",
    path: "/line/webhook",
    body: JSON.parse(rawBody),
    rawBody,
    headers: { "x-line-signature": signature ?? sign(rawBody, secret) },
  });
  return { status: res.status, body: JSON.parse(res.body) };
}
const groupSrc = (groupId = GROUP) => ({ type: "group", groupId, userId: "Uxxx" });
const textEv = (text, groupId = GROUP) => ({ type: "message", replyToken: `rt-${text}`, source: groupSrc(groupId), message: { type: "text", id: "1", text } });

async function setup({ env = ENV, now = "2026-10-11T12:00", target = true } = {}) {
  const t = makeTeam({ features: FEATURES, env, now });
  const admin = await t.join("監督");
  if (target) {
    await hook(t, [{ type: "join", replyToken: "rt-join", source: groupSrc() }]);
    const r = await admin.patch("/line/settings", { targetGroupId: GROUP });
    assert.equal(r.status, 200);
  }
  calls = [];
  return { t, admin };
}

async function addEvent(t, e) {
  const row = { type: "game", title: "練習試合", status: "scheduled", created_at: 0, updated_at: 0, ...e };
  const keys = Object.keys(row);
  const { lastId } = await t.db.run(`INSERT INTO events(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k]));
  return t.db.one("SELECT * FROM events WHERE id = ?", lastId);
}
const rsvp = async (t, eventId, memberId, status) =>
  t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, ?, 0)", eventId, memberId, status);
const emit = (t, name, payload) => t.anon.post("/_emit", { name, payload });

// ---------------------------------------------------------------- 署名検証
test("署名検証: 正しい署名は通り、誤りは 401、シークレット未設定は 200 で無視", async () => {
  const t = makeTeam({ features: FEATURES, env: ENV });
  assert.equal((await hook(t, [])).status, 200);
  assert.equal((await hook(t, [], { signature: sign("other body") })).status, 401);
  assert.equal((await hook(t, [], { secret: "wrong" })).status, 401);
  assert.equal((await hook(t, [], { signature: "" })).status, 401);
  assert.equal((await hook(t, [], { signature: "!!!not base64" })).status, 401);

  const none = makeTeam({ features: FEATURES, env: {} });
  const r = await hook(none, [{ type: "join", replyToken: "x", source: groupSrc() }], { signature: "anything" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, true);
  assert.equal((await none.db.all("SELECT * FROM line_groups")).length, 0);
  assert.equal(calls.length, 0);

  assert.equal(await verifySignature(SECRET, "abc", sign("abc")), true);
  assert.equal(await verifySignature(SECRET, "abc", sign("abd")), false);
  assert.equal(await verifySignature("", "abc", sign("abc", "")), false);
});

test("join でグループを記録し、グループ名を取得してあいさつを返す", async () => {
  const t = makeTeam({ features: FEATURES, env: ENV });
  const admin = await t.join("監督");
  const r = await hook(t, [{ type: "join", replyToken: "rt-1", source: groupSrc() }]);
  assert.equal(r.status, 200);
  const g = await t.db.one("SELECT * FROM line_groups WHERE group_id = ?", GROUP);
  assert.equal(g.name, "常磐ナイン連絡");
  assert.equal(g.joined, 1);
  const summary = calls.find((c) => c.url.includes(`/group/${GROUP}/summary`));
  assert.ok(summary);
  assert.equal(summary.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(replies().length, 1);
  assert.match(replies()[0].body.messages[0].text, /LINE通知/);

  // メッセージでも最終確認日時を更新・退出で joined=0
  t.setNow("2026-10-12T09:00");
  await hook(t, [textEv("こんにちは")]);
  assert.ok((await t.db.one("SELECT last_seen_at FROM line_groups")).last_seen_at > g.last_seen_at);
  await hook(t, [{ type: "leave", source: groupSrc() }]);
  const st = await admin.get("/line/status");
  assert.equal(st.body.groups[0].joined, false);
  // 1対1のトークは記録しない
  await hook(t, [{ type: "follow", replyToken: "x", source: { type: "user", userId: "U1" } }]);
  assert.equal((await t.db.all("SELECT * FROM line_groups")).length, 1);
});

// ---------------------------------------------------------------- コマンド
test("コマンド: 次の予定・出欠・ランキング・ヘルプに返信し、それ以外は無反応", async () => {
  const { t } = await setup();
  const taro = await t.join("太郎");
  await t.join("次郎");
  const ev = await addEvent(t, { title: "秋季リーグ", opponent: "川口ベアーズ", date: "2026-10-18", meet_time: "07:30", venue: "荒川河川敷A面", belongings: "ユニフォーム" });
  await addEvent(t, { title: "過去の試合", date: "2026-10-01" });
  await rsvp(t, ev.id, taro.member.id, "yes");
  calls = [];

  await hook(t, [textEv("こんにちは"), textEv("次の予定はいつ？だれか教えて")]);
  assert.equal(replies().length, 0);

  await hook(t, [textEv("次の予定")]);
  let rep = replies().at(-1).body;
  assert.equal(rep.replyToken, "rt-次の予定");
  const s = json(rep.messages);
  assert.equal(rep.messages[0].type, "flex");
  assert.match(s, /秋季リーグ/);
  assert.match(s, /07:30/);
  assert.match(s, /荒川河川敷A面/);
  assert.match(s, /liff\.line\.me\/2000000000-abcdEFGH\/#\/schedule\/1/);

  await hook(t, [textEv("出欠")]);
  rep = json(replies().at(-1).body.messages);
  assert.match(rep, /出席 1人/);
  assert.match(rep, /監督、次郎/); // 未回答者

  // ランキング（確定した試合のみ集計）
  const { lastId: gid } = await t.db.run("INSERT INTO games(season, date, opponent, status, our_score, their_score, created_at, updated_at) VALUES(2026, '2026-10-04', 'A', 'final', 5, 3, 0, 0)");
  await t.db.run("INSERT INTO batting(game_id, member_id, pa, ab, h, hr, rbi, updated_at) VALUES(?, ?, 4, 4, 3, 1, 3, 0)", gid, taro.member.id);
  await hook(t, [textEv("ランキング")]);
  rep = json(replies().at(-1).body.messages);
  assert.match(rep, /打撃ランキング/);
  assert.match(rep, /太郎/);
  assert.match(rep, /\.750/);

  await hook(t, [textEv("ヘルプ")]);
  rep = json(replies().at(-1).body.messages);
  assert.match(rep, /https:\/\/liff\.line\.me\/2000000000-abcdEFGH/);
  assert.match(rep, /ランキング/);

  assert.equal(parseCommand("@常磐bot 次の予定"), "next");
  assert.equal(parseCommand(" 出欠？ "), "attendance");
  assert.equal(parseCommand("ランキング見せて"), null);
});

test("通知先以外のグループではチームの情報を返さない（ヘルプのみ案内）", async () => {
  const { t } = await setup();
  await addEvent(t, { title: "秋季リーグ", date: "2026-10-18" });
  const other = "Cother000000000000000000000000002";
  await hook(t, [textEv("次の予定", other), textEv("出欠", other)]);
  assert.equal(replies().length, 0);
  await hook(t, [textEv("ヘルプ", other)]);
  assert.equal(replies().length, 1);
  assert.doesNotMatch(json(replies()[0].body), /秋季リーグ/);
  assert.match(replies()[0].body.messages[0].text, /通知先に設定されていません/);
});

// ---------------------------------------------------------------- 設定 API
test("設定 API は管理者のみ・不正な値は 400・トークン等は返さない", async () => {
  const { t, admin } = await setup();
  const taro = await t.join("太郎");
  assert.equal((await taro.get("/line/status")).status, 403);
  assert.equal((await taro.patch("/line/settings", { notify: { eventCreated: false } })).status, 403);
  assert.equal((await taro.post("/line/test")).status, 403);
  assert.equal((await t.anon.get("/line/status")).status, 401);

  const st = await admin.get("/line/status");
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.configured, { token: true, secret: true, liff: true });
  assert.equal(st.body.target.id, GROUP);
  assert.equal(st.body.target.name, "常磐ナイン連絡");
  assert.equal(st.body.ready, true);
  assert.equal(st.body.notify.memberJoined, true);
  assert.equal(st.body.notify.notice, "important");
  assert.equal(st.body.webhookPath, "/api/line/webhook");
  assert.doesNotMatch(JSON.stringify(st.body), new RegExp(`${TOKEN}|${SECRET}`));

  assert.equal((await admin.patch("/line/settings", { targetGroupId: "Cunknown" })).status, 400);
  assert.equal((await admin.patch("/line/settings", { notify: { nope: true } })).status, 400);
  assert.equal((await admin.patch("/line/settings", { notify: { notice: "maybe" } })).status, 400);
  assert.equal((await admin.patch("/line/settings", { notify: { eventCreated: "yes" } })).status, 400);
  const ok = await admin.patch("/line/settings", { notify: { eventCreated: false, notice: "all" } });
  assert.equal(ok.body.notify.eventCreated, false);
  assert.equal(ok.body.notify.notice, "all");
  assert.equal(ok.body.notify.gameResult, true);
  assert.equal((await admin.patch("/line/settings", { targetGroupId: null })).body.target, null);
});

test("テスト送信: 通知先に push・未設定ならエラー・送信履歴に残る", async () => {
  const { t, admin } = await setup();
  const r = await admin.post("/line/test");
  assert.equal(r.status, 200);
  assert.equal(pushes().length, 1);
  assert.equal(pushes()[0].body.to, GROUP);
  assert.equal(pushes()[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal((await admin.get("/line/status")).body.log[0].ok, true);

  // LINE 側のエラー
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "The bot is not in the group" }), { status: 400 });
  const bad = await admin.post("/line/test");
  assert.equal(bad.status, 502);
  const log = (await admin.get("/line/status")).body.log[0];
  assert.equal(log.ok, false);
  assert.match(log.detail, /HTTP 400/);

  await admin.patch("/line/settings", { targetGroupId: null });
  assert.equal((await admin.post("/line/test")).status, 400);
});

test("トークン未設定なら通知もコマンド返信も fetch しない", async () => {
  const env = { LINE_MESSAGING_SECRET: SECRET };
  const t = makeTeam({ features: FEATURES, env });
  const admin = await t.join("監督");
  await hook(t, [{ type: "join", replyToken: "rt", source: groupSrc() }]);
  assert.equal((await t.db.all("SELECT * FROM line_groups")).length, 1); // 記録はする
  await admin.patch("/line/settings", { targetGroupId: GROUP });
  await hook(t, [textEv("次の予定")]);
  await t.join("太郎");
  await emit(t, "event.created", { event: await addEvent(t, { title: "練習", date: "2026-10-18" }) });
  t.setNow("2026-10-17T20:00");
  await t.cron();
  assert.equal(calls.length, 0);
  assert.equal((await admin.post("/line/test")).status, 400);
  assert.equal((await admin.get("/line/status")).body.configured.token, false);

  // 何も設定されていない環境でもエラーにならない
  const bare = makeTeam({ features: allFeatures, env: {} });
  await bare.join("監督");
  await bare.join("太郎");
  await bare.cron();
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- イベント購読
test("イベント購読: 予定の追加・変更・中止・新メンバーを push、オフの種類は送らない", async () => {
  const { t, admin } = await setup();
  const ev = await addEvent(t, { title: "練習試合", opponent: "荒川クラブ", date: "2026-10-18", meet_time: "08:00", venue: "荒川A面" });

  await emit(t, "event.created", { event: ev });
  assert.equal(pushes().length, 1);
  let p = pushes()[0].body;
  assert.equal(p.to, GROUP);
  assert.equal(p.messages[0].type, "flex");
  assert.match(p.messages[0].altText, /10\/18\(日\)/);
  assert.match(json(p), /荒川A面/);
  assert.match(json(p), /#\/schedule\/1/);

  // 重要でない変更（メモ）は流さない
  await emit(t, "event.updated", { event: { ...ev, note: "雨天決行" }, before: ev });
  assert.equal(pushes().length, 1);
  // 集合時間・球場の変更は流す
  await emit(t, "event.updated", { event: { ...ev, meet_time: "07:30", venue: "荒川B面" }, before: ev });
  assert.equal(pushes().length, 2);
  p = json(pushes()[1].body);
  assert.match(p, /予定の変更/);
  assert.match(p, /08:00 → 07:30/);
  assert.match(p, /荒川A面 → 荒川B面/);

  // 中止（updated と canceled が両方来ても1回だけ）
  const canceled = { ...ev, status: "canceled", updated_at: 5 };
  await emit(t, "event.updated", { event: canceled, before: ev });
  await emit(t, "event.canceled", { event: canceled });
  assert.equal(pushes().length, 3);
  assert.match(json(pushes()[2].body), /中止/);

  // 新メンバー
  await t.join("新人", { number: "51" });
  assert.equal(pushes().length, 4);
  assert.match(json(pushes()[3].body), /新人 さん/);

  // オフにした種類は送らない
  await admin.patch("/line/settings", { notify: { eventCreated: false, eventChanged: false, memberJoined: false } });
  await emit(t, "event.created", { event: { ...ev, id: 99 } });
  await emit(t, "event.updated", { event: { ...ev, date: "2026-10-25" }, before: ev });
  await emit(t, "event.canceled", { event: { ...ev, id: 99, status: "canceled" } });
  await t.join("二人目");
  assert.equal(pushes().length, 4);
});

test("イベント購読: 日程調整・試合結果（スコアボード）・お知らせ（重要のみ / すべて）", async () => {
  const { t, admin } = await setup();
  const taro = await t.join("太郎");
  calls = [];

  await emit(t, "poll.created", { poll: { id: 3, title: "11月の練習試合", deadline: "2026-10-20" }, options: [{ date: "2026-11-01" }, { date: "2026-11-08", start_time: "09:00" }] });
  assert.equal(pushes().length, 1);
  assert.match(json(pushes()[0].body), /11\/1\(日\)/);
  assert.match(json(pushes()[0].body), /#\/polls\/3/);

  const ev = await addEvent(t, { title: "練習試合", date: "2026-11-08" });
  await emit(t, "poll.decided", { poll: { id: 3, title: "11月の練習試合" }, event: ev });
  assert.equal(pushes().length, 2);
  assert.match(json(pushes()[1].body), /日程が決まりました/);

  const { lastId } = await t.db.run(
    `INSERT INTO games(season, date, opponent, venue, innings, bat_first, our_score, their_score, line_us, line_them, status, mvp_member_id, created_at, updated_at)
     VALUES(2026, '2026-10-11', '川口ベアーズ', '荒川A面', 7, 1, 6, 4, '[1,0,2,0,3,0,0]', '[0,0,1,0,0,3,0]', 'final', ?, 0, 0)`,
    taro.member.id,
  );
  await t.db.run("INSERT INTO batting(game_id, member_id, pa, ab, h, hr, rbi, updated_at) VALUES(?, ?, 4, 4, 3, 1, 4, 0)", lastId, taro.member.id);
  const game = await t.db.one("SELECT * FROM games WHERE id = ?", lastId);
  await emit(t, "game.finalized", { game });
  await emit(t, "game.finalized", { game }); // 二重には送らない
  assert.equal(pushes().length, 3);
  const g = json(pushes()[2].body);
  assert.match(pushes()[2].body.messages[0].altText, /6-4 で勝利/);
  assert.match(g, /WIN/);
  assert.match(g, /MVP/);
  assert.match(g, /太郎 3安打 1本塁打 4打点/);
  assert.match(g, /#\/games\/1/);

  // お知らせ: 既定は重要のみ
  await emit(t, "notice.created", { notice: { id: 1, title: "部費の集金", body: "1000円です" }, author: { name: "監督" } });
  assert.equal(pushes().length, 3);
  await emit(t, "notice.created", { notice: { id: 2, title: "ユニフォーム発注", body: "サイズを回答", important: 1 }, author: { name: "監督" } });
  assert.equal(pushes().length, 4);
  assert.match(json(pushes()[3].body), /重要なお知らせ/);
  await admin.patch("/line/settings", { notify: { notice: "all" } });
  await emit(t, "notice.created", { notice: { id: 3, title: "飲み会", body: "参加者募集" }, author: { name: "監督" } });
  assert.equal(pushes().length, 5);
  await admin.patch("/line/settings", { notify: { notice: "off", poll: false, gameResult: false } });
  await emit(t, "notice.created", { notice: { id: 4, title: "緊急", body: "x", important: true }, author: null });
  await emit(t, "poll.created", { poll: { id: 4, title: "x" }, options: [] });
  await emit(t, "game.finalized", { game: { ...game, id: 50 } });
  assert.equal(pushes().length, 5);
});

// ---------------------------------------------------------------- cron
test("cron 前日リマインド: 前日20:00以降の最初の実行で1回だけ・未回答者の名前", async () => {
  const { t, admin } = await setup({ now: "2026-10-17T12:00" });
  const taro = await t.join("太郎");
  await t.join("次郎");
  const hanako = await t.join("花子");
  const ev = await addEvent(t, { title: "秋季リーグ", date: "2026-10-18", meet_time: "07:30", venue: "荒川A面", belongings: "白ユニ・スパイク" });
  await addEvent(t, { title: "中止の予定", date: "2026-10-18", status: "canceled" });
  await rsvp(t, ev.id, taro.member.id, "yes");
  await rsvp(t, ev.id, hanako.member.id, "no");
  calls = [];

  t.setNow("2026-10-17T19:45");
  await t.cron();
  assert.equal(pushes().length, 0);
  t.setNow("2026-10-17T20:00");
  await t.cron();
  assert.equal(pushes().length, 1);
  const s = json(pushes()[0].body);
  assert.match(s, /明日は試合です/);
  assert.match(s, /07:30/);
  assert.match(s, /荒川A面/);
  assert.match(s, /白ユニ・スパイク/);
  assert.match(s, /未回答: 監督、次郎/);
  assert.doesNotMatch(s, /中止の予定/);
  t.setNow("2026-10-17T20:15");
  await t.cron();
  t.setNow("2026-10-17T23:45");
  await t.cron();
  assert.equal(pushes().length, 1);

  // オフなら送らない
  await admin.patch("/line/settings", { notify: { remindEve: false } });
  await addEvent(t, { title: "練習", type: "practice", date: "2026-10-19" });
  t.setNow("2026-10-18T21:00");
  await t.cron();
  assert.equal(pushes().length, 0 + 1);
});

test("cron 起床チェック: 集合90分前以降に、出席なのに起床報告がない人だけ・wakeups が無ければスキップ", async () => {
  const { t } = await setup({ now: "2026-10-18T04:00" });
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  const hanako = await t.join("花子");
  const ev = await addEvent(t, { title: "秋季リーグ", date: "2026-10-18", meet_time: "07:30" });
  await rsvp(t, ev.id, taro.member.id, "yes");
  await rsvp(t, ev.id, jiro.member.id, "yes");
  await rsvp(t, ev.id, hanako.member.id, "no");
  calls = [];

  // wakeups テーブルが無い（community 未実装）→ 何もしない
  t.setNow("2026-10-18T06:00");
  await t.cron();
  assert.equal(pushes().length, 0);
  assert.equal((await t.db.one("SELECT COUNT(*) AS n FROM sent_log WHERE key LIKE 'line:wake:%'")).n, 0);

  await t.db.exec("CREATE TABLE wakeups (id BIGSERIAL PRIMARY KEY, event_id BIGINT, member_id BIGINT, at BIGINT, comment TEXT)");
  await t.db.run("INSERT INTO wakeups(event_id, member_id, at) VALUES(?, ?, 0)", ev.id, taro.member.id);

  t.setNow("2026-10-18T05:45"); // 105分前
  await t.cron();
  assert.equal(pushes().length, 0);
  t.setNow("2026-10-18T06:00"); // 90分前
  await t.cron();
  assert.equal(pushes().length, 1);
  const s = json(pushes()[0].body);
  assert.match(s, /起きてますか/);
  assert.match(s, /次郎/);
  assert.doesNotMatch(s, /太郎|花子/);
  t.setNow("2026-10-18T06:15");
  await t.cron();
  assert.equal(pushes().length, 1);
});

test("cron 出欠締切リマインド: 締切前日20:00に未回答者・全員回答済みなら送らない", async () => {
  const { t } = await setup({ now: "2026-10-14T12:00" });
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  await t.db.run("UPDATE members SET is_guest = 1 WHERE id = ?", jiro.member.id); // 助っ人は対象外
  const ev = await addEvent(t, { title: "秋季リーグ", date: "2026-10-25", rsvp_deadline: "2026-10-15" });
  const done = await addEvent(t, { title: "全員回答済み", date: "2026-10-26", rsvp_deadline: "2026-10-15" });
  await rsvp(t, ev.id, taro.member.id, "yes");
  await rsvp(t, done.id, taro.member.id, "yes");
  await rsvp(t, done.id, (await t.db.one("SELECT id FROM members WHERE name = '監督'")).id, "no");
  calls = [];

  t.setNow("2026-10-14T19:59");
  await t.cron();
  assert.equal(pushes().length, 0);
  t.setNow("2026-10-14T20:00");
  await t.cron();
  await t.cron();
  assert.equal(pushes().length, 1);
  const s = json(pushes()[0].body);
  assert.match(s, /出欠の締切は明日/);
  assert.match(s, /監督/);
  assert.doesNotMatch(s, /次郎|全員回答済み/);
});

test("cron 成績入力リマインド: 試合翌日20:00に打席0の出場者・確定済みの試合は対象外", async () => {
  const { t } = await setup({ now: "2026-10-12T12:00" });
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  const ins = async (status) =>
    (await t.db.run("INSERT INTO games(season, date, opponent, status, created_at, updated_at) VALUES(2026, '2026-10-11', '川口', ?, 0, 0)", status)).lastId;
  const draft = await ins("draft");
  const final = await ins("final");
  await t.db.run("INSERT INTO batting(game_id, member_id, pa, ab, h, updated_at) VALUES(?, ?, 4, 3, 1, 0)", draft, taro.member.id);
  await t.db.run("INSERT INTO batting(game_id, member_id, pa, updated_at) VALUES(?, ?, 0, 0)", draft, jiro.member.id);
  await t.db.run("INSERT INTO batting(game_id, member_id, pa, updated_at) VALUES(?, ?, 0, 0)", final, taro.member.id);
  calls = [];

  await t.cron();
  assert.equal(pushes().length, 0);
  t.setNow("2026-10-12T20:00");
  await t.cron();
  t.setNow("2026-10-12T20:15");
  await t.cron();
  assert.equal(pushes().length, 1);
  const s = json(pushes()[0].body);
  assert.match(s, /成績入力のお願い/);
  assert.match(s, /次郎/);
  assert.doesNotMatch(s, /太郎/);
  assert.match(s, /#\/games\/1/);
});

test("通知先が未設定なら cron もイベントも送らない", async () => {
  const { t } = await setup({ target: false, now: "2026-10-17T20:00" });
  await addEvent(t, { title: "秋季リーグ", date: "2026-10-18" });
  await t.cron();
  await emit(t, "event.created", { event: await addEvent(t, { title: "練習", date: "2026-10-20" }) });
  assert.equal(calls.length, 0);
  assert.equal((await t.db.one("SELECT COUNT(*) AS n FROM sent_log WHERE key LIKE 'line:%'")).n, 0);
});

// ---------------------------------------------------------------- flex
test("flex: 空の値は出さず、LIFF が無ければボタンを出さない", () => {
  const m = flexMessage("x", eventBubble({ id: 1, title: "練習", date: "2026-10-18", type: "practice" }));
  const s = json(m);
  assert.doesNotMatch(s, /"text":""/);
  assert.equal(m.contents.footer, undefined);
  const r = resultBubble({ date: "2026-10-11", opponent: "A", our_score: 2, their_score: 2, line_us: "[1,1]", line_them: "[2,0]" }, { url: "https://liff.line.me/x/#/games/1" });
  assert.match(json(r), /DRAW/);
  assert.equal(r.footer.contents[0].action.uri, "https://liff.line.me/x/#/games/1");
});

