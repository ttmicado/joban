import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";
import { features as allFeatures } from "../src/team/features/index.js";

// 予定を直接 INSERT（schedule 機能に依存しない）
function addEvent(t, { date, meet = "08:00", start = "09:00", status = "scheduled", title = "練習試合" }) {
  const { lastId } = t.db.run(
    `INSERT INTO events(type, title, date, meet_time, start_time, status, created_at, updated_at)
     VALUES('game', ?, ?, ?, ?, ?, 0, 0)`,
    title,
    date,
    meet,
    start,
    status,
  );
  return lastId;
}
const rsvp = (t, eventId, memberId, status = "yes") =>
  t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, ?, 0)", eventId, memberId, status);

function spyTeam(now) {
  const events = [];
  const spy = {
    name: "spy",
    on: Object.fromEntries(
      ["notice.created", "wakeup.created", "practice.created"].map((n) => [n, (_c, p) => events.push([n, p])]),
    ),
  };
  return { t: makeTeam({ features: [...allFeatures, spy], now }), events };
}

// ---------------------------------------------------------------- お知らせ
test("お知らせ: メンバーも投稿できるが、ピン留め・重要は管理者のみ", async () => {
  const { t, events } = spyTeam();
  const admin = await t.join("監督");
  const taro = await t.join("太郎");

  assert.equal((await taro.post("/notices", { body: "" })).status, 400);
  const ok = await taro.post("/notices", { category: "chat", body: "明日晴れるといいね\nよろしく" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.notice.body, "明日晴れるといいね\nよろしく");
  assert.equal((await taro.post("/notices", { body: "x", pinned: true })).status, 403);
  assert.equal((await taro.post("/notices", { body: "x", category: "important" })).status, 403);
  assert.equal((await taro.post("/notices", { body: "x", category: "foo" })).status, 400);

  const imp = await admin.post("/notices", { category: "important", title: "集合時間変更", body: "7:30集合です", pinned: true });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.notice.pinned, true);

  // ピン留めが先頭
  const list = await taro.get("/notices");
  assert.deepEqual(list.body.notices.map((n) => n.title), ["集合時間変更", ""]);
  assert.equal(list.body.unread, 1); // 自分の投稿は既読

  // emit
  const created = events.filter(([n]) => n === "notice.created");
  assert.equal(created.length, 2);
  assert.equal(created[1][1].author.name, "監督");
  assert.equal(created[1][1].notice.title, "集合時間変更");
  assert.equal(created[1][1].author.line_user_id, undefined);
});

test("お知らせ: 開いたら既読、了解は別。集計と未了解の人", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  await admin.post("/members", { name: "助っ人" }); // LINE 未連携は対象外

  const { notice } = (await admin.post("/notices", { body: "グラウンド代 500円です" })).body;
  assert.equal(notice.total, 3);
  assert.equal(notice.ackCount, 1);

  const pending = await taro.get("/notices/pending");
  assert.equal(pending.body.count, 1);
  assert.equal(pending.body.notice.id, notice.id);
  assert.equal((await admin.get("/notices/pending")).body.count, 0); // 自分の投稿は対象外

  const d = await taro.get(`/notices/${notice.id}`);
  assert.equal(d.body.notice.read, true);
  assert.equal(d.body.notice.acked, false);
  assert.equal(d.body.notice.readCount, 2);
  assert.equal(d.body.notice.ackCount, 1);
  assert.deepEqual(d.body.notAcked.map((m) => [m.name, m.read]), [["太郎", true], ["次郎", false]]);

  const ack = await taro.post(`/notices/${notice.id}/ack`);
  assert.equal(ack.body.notice.acked, true);
  assert.equal(ack.body.notice.ackCount, 2);
  assert.equal((await taro.get("/notices/pending")).body.count, 0);
  // 二度押しても数は変わらない
  assert.equal((await taro.post(`/notices/${notice.id}/ack`)).body.notice.ackCount, 2);

  const d2 = await admin.get(`/notices/${notice.id}`);
  assert.deepEqual(d2.body.acked.map((m) => m.name), ["監督", "太郎"]);
  assert.deepEqual(d2.body.notAcked.map((m) => m.name), ["次郎"]);

  // 未読カウント
  assert.equal((await jiro.get("/notices")).body.unread, 1);
  await jiro.get(`/notices/${notice.id}`);
  assert.equal((await jiro.get("/notices")).body.unread, 0);

  // 取り消し
  assert.equal((await taro.del(`/notices/${notice.id}/ack`)).body.notice.acked, false);
  assert.equal((await t.anon.get("/notices")).status, 401);
  assert.equal((await taro.get("/notices/9999")).status, 404);
  assert.equal((await taro.get("/notices/abc")).status, 400);
});

test("お知らせ: 編集・削除は投稿者か管理者", async () => {
  const t = makeTeam();
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  const { notice } = (await taro.post("/notices", { body: "練習おつかれさま" })).body;

  assert.equal((await jiro.patch(`/notices/${notice.id}`, { body: "改ざん" })).status, 403);
  assert.equal((await jiro.del(`/notices/${notice.id}`)).status, 403);
  const e1 = await taro.patch(`/notices/${notice.id}`, { body: "練習おつかれさまでした" });
  assert.equal(e1.status, 200);
  assert.equal(e1.body.notice.body, "練習おつかれさまでした");
  assert.equal((await taro.patch(`/notices/${notice.id}`, { pinned: true })).status, 403);
  const e2 = await admin.patch(`/notices/${notice.id}`, { pinned: true, category: "important" });
  assert.equal(e2.body.notice.pinned, true);
  assert.equal(e2.body.notice.category, "important");
  // 投稿者が本文を直しても管理者のピン・重要は残る
  const e3 = await taro.patch(`/notices/${notice.id}`, { body: "追記あり" });
  assert.equal(e3.body.notice.pinned, true);
  assert.equal(e3.body.notice.category, "important");

  assert.equal((await admin.del(`/notices/${notice.id}`)).status, 200);
  assert.equal((await taro.get(`/notices/${notice.id}`)).status, 404);
  const own = (await jiro.post("/notices", { body: "x" })).body.notice;
  assert.equal((await jiro.del(`/notices/${own.id}`)).status, 200);
});

// ---------------------------------------------------------------- 起床報告
test("起床: 順位・ステージ・emit・当日以外は不可", async () => {
  const { t, events } = spyTeam("2026-10-18T05:30");
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  const today = addEvent(t, { date: "2026-10-18" });
  const tomorrow = addEvent(t, { date: "2026-10-19" });
  const canceled = addEvent(t, { date: "2026-10-18", status: "canceled" });
  for (const m of [admin, taro, jiro]) rsvp(t, today, m.member.id, m === jiro ? "no" : "yes");

  assert.equal((await taro.post(`/wakeups/${tomorrow}`, { stage: "woke" })).status, 400);
  assert.equal((await taro.post(`/wakeups/${canceled}`, { stage: "woke" })).status, 400);
  assert.equal((await taro.post(`/wakeups/9999`, { stage: "woke" })).status, 404);
  assert.equal((await taro.post(`/wakeups/${today}`, { stage: "sleep" })).status, 400);

  const tdy = await taro.get("/wakeups/today");
  assert.deepEqual(tdy.body.events.map((e) => e.event.id), [today]);
  assert.equal(tdy.body.events[0].beforeStart, true);
  assert.equal(tdy.body.events[0].counts.attending, 2);

  const w1 = await taro.post(`/wakeups/${today}`, { stage: "woke", comment: "おはよう！" });
  assert.equal(w1.status, 200);
  assert.equal(w1.body.rank, 1);
  assert.equal(w1.body.created, true);
  assert.equal((await taro.post(`/wakeups/${today}`, { stage: "woke" })).status, 409);

  t.setNow("2026-10-18T05:40");
  const w2 = await admin.post(`/wakeups/${today}`, { stage: "woke" });
  assert.equal(w2.body.rank, 2);
  assert.equal(w2.body.counts.wokeAttending, 2);
  assert.equal(w2.body.counts.attending, 2);

  // 出発 → 遅刻 → 到着
  t.setNow("2026-10-18T06:30");
  const l = await taro.post(`/wakeups/${today}`, { stage: "left" });
  assert.ok(l.body.me.wakeup.leftAt);
  assert.equal((await taro.post(`/wakeups/${today}`, { stage: "late" })).status, 400);
  const late = await taro.post(`/wakeups/${today}`, { stage: "late", lateMinutes: 15, comment: "電車遅延" });
  assert.equal(late.body.me.wakeup.lateMinutes, 15);
  assert.equal(late.body.me.wakeup.comment, "電車遅延");
  const arr = await taro.post(`/wakeups/${today}`, { stage: "arrived" });
  assert.ok(arr.body.me.wakeup.arrivedAt);
  assert.equal(arr.body.counts.arrived, 1);

  // いきなり到着でも起床扱い（3番目）
  const j = await jiro.post(`/wakeups/${today}`, { stage: "arrived" });
  assert.equal(j.body.rank, 3);
  assert.ok(j.body.me.wakeup.leftAt);

  // 取り消し
  const undo = await jiro.del(`/wakeups/${today}`);
  assert.equal(undo.body.me.wakeup, null);

  const board = await jiro.get(`/wakeups/${today}`);
  const names = board.body.people.map((p) => [p.member.name, p.attendance, p.wakeup?.rank ?? null]);
  assert.deepEqual(names, [["監督", "yes", 2], ["太郎", "yes", 1], ["次郎", "no", null]]);

  const woke = events.filter(([n]) => n === "wakeup.created");
  assert.equal(woke.length, 3); // 太郎・監督・次郎（起床時のみ。出発などでは増えない）
  assert.equal(woke[0][1].member.name, "太郎");
  assert.equal(woke[0][1].event.id, today);
  assert.equal(woke[0][1].wakeup.comment, "おはよう！");
  assert.equal(typeof woke[0][1].wakeup.at, "number");

  // 開始後は beforeStart = false
  t.setNow("2026-10-18T09:10");
  assert.equal((await taro.get("/wakeups/today")).body.events[0].beforeStart, false);
});

test("起床ランキング: 一番乗り回数と平均（集合の何分前）", async () => {
  const t = makeTeam({ now: "2026-05-01T06:00" });
  const a = await t.join("監督");
  const b = await t.join("太郎");
  const e1 = addEvent(t, { date: "2026-05-01", meet: "08:00" });
  await b.post(`/wakeups/${e1}`, { stage: "woke" }); // 120分前
  t.setNow("2026-05-01T07:00");
  await a.post(`/wakeups/${e1}`, { stage: "woke" }); // 60分前

  t.setNow("2026-05-08T06:30");
  const e2 = addEvent(t, { date: "2026-05-08", meet: "08:00" });
  await b.post(`/wakeups/${e2}`, { stage: "woke" }); // 90分前

  const r = await a.get("/wakeups/ranking?season=2026");
  assert.equal(r.status, 200);
  assert.equal(r.body.events, 2);
  const [first, second] = r.body.ranking;
  assert.equal(first.member.name, "太郎");
  assert.equal(first.firsts, 2);
  assert.equal(first.avgBefore, 105);
  assert.equal(first.avgTime, 6 * 60 + 15);
  assert.equal(second.firsts, 0);
  assert.equal(second.avgBefore, 60);
  assert.equal((await a.get("/wakeups/ranking?season=2025")).body.ranking.length, 0);
});

test("開発用の予定作成は ALLOW_MOCK のときだけ", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  assert.equal((await a.post("/wakeups/dev-event")).status, 404);
  const t2 = makeTeam({ env: { ALLOW_MOCK: "true" } });
  const a2 = await t2.join("監督");
  const b2 = await t2.join("太郎");
  assert.equal((await b2.post("/wakeups/dev-event")).status, 403);
  const r = await a2.post("/wakeups/dev-event");
  assert.equal(r.status, 200);
  assert.equal((await b2.get("/wakeups/today")).body.events[0].counts.attending, 2);
});

// ---------------------------------------------------------------- 練習報告
test("練習: 投稿・検証・編集削除の権限・emit", async () => {
  const { t, events } = spyTeam("2026-10-11T20:00");
  const admin = await t.join("監督");
  const taro = await t.join("太郎");

  assert.equal((await taro.post("/practices", { items: [] })).status, 400);
  assert.equal((await taro.post("/practices", { items: [{ kind: "nap", amount: 1, unit: "回" }] })).status, 400);
  assert.equal((await taro.post("/practices", { items: [{ kind: "swing", amount: -1, unit: "回" }] })).status, 400);
  assert.equal((await taro.post("/practices", { date: "2026-10-12", items: [{ kind: "swing", amount: 1, unit: "回" }] })).status, 400);

  const r = await taro.post("/practices", {
    items: [
      { kind: "swing", amount: 300, unit: "回" },
      { kind: "run", amount: 5.25, unit: "km" },
    ],
    comment: "雨なので室内で",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.practice.date, "2026-10-11");
  assert.equal(r.body.practice.items[1].amount, 5.3);
  assert.equal(r.body.summary.streak, 1);
  const id = r.body.practice.id;

  const ev = events.filter(([n]) => n === "practice.created");
  assert.equal(ev.length, 1);
  assert.equal(ev[0][1].member.name, "太郎");
  assert.equal(ev[0][1].practice.id, id);

  assert.equal((await admin.patch(`/practices/${id}`, { comment: "x" })).status, 403);
  const p = await taro.patch(`/practices/${id}`, { comment: "やっぱり外で" });
  assert.equal(p.body.practice.comment, "やっぱり外で");
  assert.equal(p.body.practice.items.length, 2);

  const other = (await admin.post("/practices", { items: [{ kind: "catch", amount: 30, unit: "分" }] })).body.practice;
  assert.equal((await taro.del(`/practices/${other.id}`)).status, 403);
  const feed = await taro.get("/practices");
  assert.deepEqual(feed.body.practices.map((x) => x.id), [other.id, id]);
  assert.equal(feed.body.practices[1].mine, true);
  assert.equal((await taro.del(`/practices/${id}`)).status, 200);
  assert.equal((await taro.get(`/practices/${id}`)).status, 404);
});

test("練習: ナイス！（二重不可・取り消し）", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const b = await t.join("太郎");
  const { practice } = (await a.post("/practices", { items: [{ kind: "knock", amount: 100, unit: "球" }] })).body;
  const l1 = await b.post(`/practices/${practice.id}/like`);
  assert.equal(l1.status, 200);
  assert.equal(l1.body.practice.likeCount, 1);
  assert.equal(l1.body.practice.liked, true);
  assert.equal((await b.post(`/practices/${practice.id}/like`)).status, 409);
  assert.equal((await a.post(`/practices/${practice.id}/like`)).body.practice.likeCount, 2);
  const un = await b.del(`/practices/${practice.id}/like`);
  assert.equal(un.body.practice.likeCount, 1);
  assert.equal(un.body.practice.liked, false);
  assert.equal((await b.post("/practices/999/like")).status, 404);
});

test("練習: 月間ランキング・ストリーク・カレンダー", async () => {
  const t = makeTeam({ now: "2026-10-11T21:00" });
  const a = await t.join("監督");
  const b = await t.join("太郎");
  const swing = (n) => [{ kind: "swing", amount: n, unit: "回" }];
  for (const d of ["2026-10-08", "2026-10-09", "2026-10-10"]) await b.post("/practices", { date: d, items: swing(100) });
  await b.post("/practices", { date: "2026-10-10", items: [{ kind: "run", amount: 3, unit: "km" }] });
  await b.post("/practices", { date: "2026-09-30", items: swing(500) });
  await a.post("/practices", { date: "2026-10-11", items: [...swing(50), { kind: "run", amount: 5, unit: "km" }] });

  // 今日まだでも昨日まで続いていればストリーク継続
  const s = (await b.get("/practices/summary")).body;
  assert.equal(s.streak, 3);
  assert.equal(s.practicedToday, false);
  assert.equal(s.monthDays, 3);
  assert.equal(s.monthSwings, 300);
  assert.equal(s.monthRunKm, 3);
  assert.equal(s.calendar.length, 84);
  assert.equal(s.calendar.find((c) => c.date === "2026-10-10").count, 2);
  assert.equal(s.calendar.at(-1).future, true); // 今週の土曜まで
  assert.equal(new Date(s.calendar[0].date).getUTCDay(), 0); // 日曜はじまり

  t.setNow("2026-10-13T08:00"); // 2日空いたら途切れる
  assert.equal((await b.get("/practices/summary")).body.streak, 0);
  assert.equal((await b.get("/practices/summary")).body.bestStreak, 3);

  const r = (await a.get("/practices/ranking?month=2026-10")).body;
  assert.deepEqual(r.days.map((x) => [x.member.name, x.days]), [["太郎", 3], ["監督", 1]]);
  assert.deepEqual(r.swings.map((x) => [x.member.name, x.swings]), [["太郎", 300], ["監督", 50]]);
  assert.deepEqual(r.run.map((x) => [x.member.name, x.runKm]), [["監督", 5], ["太郎", 3]]);
  assert.equal((await a.get("/practices/ranking?month=2026-13")).status, 400);
  assert.equal((await a.get("/practices/ranking?month=2026-09")).body.swings[0].swings, 500);
});
