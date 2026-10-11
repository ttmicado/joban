import assert from "node:assert/strict";
import test from "node:test";
import { features as allFeatures } from "../src/team/features/index.js";
import { icsFold } from "../src/team/features/schedule.js";
import { makeTeam } from "./helpers/team.js";

// emit されたイベントを記録するダミー機能
function spyFeature() {
  const got = [];
  const names = ["event.created", "event.updated", "event.canceled", "poll.created", "poll.decided"];
  return { got, feature: { name: "spy", on: Object.fromEntries(names.map((n) => [n, (_c, p) => got.push([n, p])])) } };
}

async function setup() {
  const spy = spyFeature();
  const t = makeTeam({ features: [...allFeatures, spy.feature], now: "2026-10-11T12:00" });
  const admin = await t.join("監督");
  const taro = await t.join("太郎");
  const jiro = await t.join("次郎");
  return { t, admin, taro, jiro, spy };
}

test("予定の作成は管理者だけ・入力チェック・タイトル自動提案", async () => {
  const { admin, taro, spy } = await setup();
  assert.equal((await taro.post("/events", { date: "2026-10-18" })).status, 403);
  assert.equal((await admin.post("/events", { date: "2026/10/18" })).status, 400);
  assert.equal((await admin.post("/events", { date: "2026-10-18", start_time: "10:00", end_time: "09:00" })).status, 400);
  assert.equal((await admin.post("/events", { date: "2026-10-18", venue_url: "javascript:alert(1)" })).status, 400);
  assert.equal((await admin.post("/events", { date: "2026-10-18", type: "party" })).status, 400);

  const res = await admin.post("/events", {
    type: "game",
    date: "2026-10-18",
    opponent: "北町タイガース",
    meet_time: "07:30",
    start_time: "08:00",
    venue: "市民球場",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.event.title, "vs 北町タイガース");
  assert.equal(res.body.event.status, "scheduled");
  const created = spy.got.find(([n]) => n === "event.created");
  assert.equal(created[1].event.id, res.body.event.id);
  assert.equal(created[1].event.title, "vs 北町タイガース");

  const p = await admin.post("/events", { type: "practice", date: "2026-10-20" });
  assert.equal(p.body.event.title, "練習");
});

test("一覧（これから・過去・月）と編集・中止・削除", async () => {
  const { t, admin, taro, spy } = await setup();
  const a = (await admin.post("/events", { date: "2026-10-18", title: "練習試合", type: "game" })).body.event;
  const b = (await admin.post("/events", { date: "2026-10-04", title: "練習", type: "practice" })).body.event;
  await admin.post("/events", { date: "2026-11-03", title: "大会", type: "game" });

  const up = await taro.get("/events?range=upcoming");
  assert.deepEqual(up.body.events.map((e) => e.title), ["練習試合", "大会"]);
  assert.deepEqual(up.body.events[0].counts, { yes: 0, maybe: 0, no: 0 });
  const past = await taro.get("/events?range=past");
  assert.deepEqual(past.body.events.map((e) => e.id), [b.id]);
  const oct = await taro.get("/events?range=month&month=2026-10");
  assert.equal(oct.body.events.length, 2);
  assert.equal((await taro.get("/events?range=month&month=2026-13")).status, 400);

  assert.equal((await taro.patch(`/events/${a.id}`, { title: "x" })).status, 403);
  const upd = await admin.patch(`/events/${a.id}`, { meet_time: "07:00", venue: "河川敷" });
  assert.equal(upd.body.event.meet_time, "07:00");
  assert.equal(upd.body.event.title, "練習試合");
  const ev = spy.got.find(([n]) => n === "event.updated");
  assert.equal(ev[1].before.meet_time, null);
  assert.equal(ev[1].event.meet_time, "07:00");

  assert.equal((await taro.post(`/events/${a.id}/cancel`)).status, 403);
  const can = await admin.post(`/events/${a.id}/cancel`);
  assert.equal(can.body.event.status, "canceled");
  assert.equal(spy.got.filter(([n]) => n === "event.canceled").length, 1);
  assert.equal((await taro.put(`/events/${a.id}/rsvp`, { status: "yes" })).status, 400);
  assert.equal((await admin.post(`/events/${a.id}/restore`)).body.event.status, "scheduled");

  // 試合結果が紐づく予定は削除できない
  t.db.run("INSERT INTO games(event_id, season, date, opponent, created_at, updated_at) VALUES(?, 2026, ?, 'x', 0, 0)", b.id, b.date);
  assert.equal((await admin.del(`/events/${b.id}`)).status, 409);
  assert.equal((await taro.get(`/events/${b.id}`)).body.game_id, 1);
  assert.equal((await taro.del(`/events/${a.id}`)).status, 403);
  assert.equal((await admin.del(`/events/${a.id}`)).status, 200);
  assert.equal((await taro.get(`/events/${a.id}`)).status, 404);
});

test("出欠の登録・更新・集計・代理入力", async () => {
  const { t, admin, taro, jiro } = await setup();
  const e = (await admin.post("/events", { date: "2026-10-18", opponent: "南町", rsvp_deadline: "2026-10-15" })).body.event;

  let r = await taro.put(`/events/${e.id}/rsvp`, { status: "yes", comment: "行けます！" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.my, { status: "yes", comment: "行けます！" });
  assert.equal(r.body.event.counts.yes, 1);
  assert.equal(r.body.unanswered.length, 2);

  r = await taro.put(`/events/${e.id}/rsvp`, { status: "maybe", comment: "" });
  assert.deepEqual(r.body.event.counts, { yes: 0, maybe: 1, no: 0 });
  assert.equal((await taro.put(`/events/${e.id}/rsvp`, { status: "ok" })).status, 400);

  // 本人以外は管理者だけ
  assert.equal((await taro.put(`/events/${e.id}/rsvp`, { status: "no", member_id: jiro.member.id })).status, 403);
  r = await admin.put(`/events/${e.id}/rsvp`, { status: "no", member_id: jiro.member.id, comment: "仕事" });
  assert.equal(r.status, 200);
  const j = r.body.attendance.find((a) => a.member.id === jiro.member.id);
  assert.equal(j.status, "no");
  assert.equal(j.comment, "仕事");
  assert.equal(r.body.attendance[0].member.line_user_id, undefined);

  // 助っ人の代理入力
  const g = (await admin.post("/members", { name: "助っ人A" })).body.member;
  r = await admin.put(`/events/${e.id}/rsvp`, { status: "yes", member_id: g.id });
  assert.equal(r.body.event.counts.yes, 1);

  const d = await jiro.get(`/events/${e.id}`);
  assert.equal(d.body.my.status, "no");
  assert.deepEqual(d.body.unanswered.map((m) => m.name), ["監督"]);
  const list = await taro.get("/events");
  assert.equal(list.body.events[0].my_status, "maybe");
  assert.deepEqual(list.body.events[0].counts, { yes: 1, maybe: 1, no: 1 });

  // 未回答（ホーム用）
  assert.equal((await admin.get("/events/pending")).body.count, 1);
  assert.equal((await taro.get("/events/pending")).body.count, 0);
  const next = await taro.get("/events/next");
  assert.equal(next.body.event.id, e.id);

  // 取り消し
  r = await taro.put(`/events/${e.id}/rsvp`, { status: null });
  assert.equal(r.body.my, null);

  // 終わった予定はメンバーは変更できない（管理者は可）
  t.setNow("2026-10-19T10:00");
  assert.equal((await taro.put(`/events/${e.id}/rsvp`, { status: "yes" })).status, 400);
  assert.equal((await admin.put(`/events/${e.id}/rsvp`, { status: "yes", member_id: taro.member.id })).status, 200);
});

test("球場マスタ", async () => {
  const { admin, taro } = await setup();
  assert.equal((await taro.post("/venues", { name: "市民球場" })).status, 403);
  const v = await admin.post("/venues", { name: "市民球場", address: "市内1-2-3", url: "https://maps.example.com/x", note: "駐車場あり（20台）" });
  assert.equal(v.status, 200);
  assert.equal((await admin.post("/venues", { name: "市民球場" })).status, 409);
  assert.equal((await admin.post("/venues", { name: "" })).status, 400);
  const p = await admin.patch(`/venues/${v.body.venue.id}`, { note: "駐車場なし" });
  assert.equal(p.body.venue.note, "駐車場なし");
  assert.equal(p.body.venue.address, "市内1-2-3");
  assert.equal((await taro.get("/venues")).body.venues.length, 1);

  // 予定の詳細に球場情報がつく
  const e = (await admin.post("/events", { date: "2026-10-18", venue: "市民球場" })).body.event;
  assert.equal((await taro.get(`/events/${e.id}`)).body.venue.note, "駐車場なし");
  assert.equal((await admin.del(`/venues/${v.body.venue.id}`)).status, 200);
});

test("日程調整: 作成・回答・集計・決定で予定ができる", async () => {
  const { admin, taro, jiro, spy } = await setup();
  const body = {
    title: "11月の練習試合",
    deadline: "2026-10-20",
    options: [
      { date: "2026-11-01", time: "09:00", note: "市民球場" },
      { date: "2026-11-08" },
      { date: "2026-11-15", time: "13:00" },
    ],
  };
  assert.equal((await taro.post("/polls", body)).status, 403);
  assert.equal((await admin.post("/polls", { ...body, options: [] })).status, 400);
  assert.equal((await admin.post("/polls", { ...body, options: [{ date: "2026-11-01" }, { date: "2026-11-01" }] })).status, 400);
  const created = await admin.post("/polls", body);
  assert.equal(created.status, 200);
  const pollId = created.body.poll.id;
  const [o1, o2, o3] = created.body.options;
  const pc = spy.got.find(([n]) => n === "poll.created");
  assert.equal(pc[1].poll.id, pollId);
  assert.equal(pc[1].options.length, 3);

  assert.equal((await taro.get("/polls")).body.polls[0].answered, false);
  assert.equal((await taro.get("/events/pending")).body.polls.length, 1);

  assert.equal((await taro.put(`/polls/${pollId}/answer`, { answers: {} })).status, 400);
  assert.equal((await taro.put(`/polls/${pollId}/answer`, { answers: { [o1.id]: "good" } })).status, 400);
  assert.equal((await taro.put(`/polls/${pollId}/answer`, { answers: { 9999: "yes" } })).status, 400);
  let r = await taro.put(`/polls/${pollId}/answer`, { answers: { [o1.id]: "maybe", [o2.id]: "yes", [o3.id]: "no" }, comment: "8日がいい" });
  assert.equal(r.status, 200);
  r = await jiro.put(`/polls/${pollId}/answer`, { answers: { [o1.id]: "yes", [o2.id]: "yes", [o3.id]: "no" } });
  r = await admin.put(`/polls/${pollId}/answer`, { answers: { [o1.id]: "yes", [o2.id]: "maybe" } });
  // 代理回答
  assert.equal((await taro.put(`/polls/${pollId}/answer`, { member_id: jiro.member.id, answers: { [o1.id]: "no" } })).status, 403);

  const d = await taro.get(`/polls/${pollId}`);
  const counts = Object.fromEntries(d.body.options.map((o) => [o.id, o.counts]));
  assert.deepEqual(counts[o1.id], { yes: 2, maybe: 1, no: 0 });
  assert.deepEqual(counts[o2.id], { yes: 2, maybe: 1, no: 0 });
  assert.deepEqual(d.body.best.sort(), [o1.id, o2.id].sort());
  assert.equal(d.body.my.comment, "8日がいい");
  assert.equal(d.body.answers.length, 3);
  assert.equal((await taro.get("/polls")).body.polls[0].answer_count, 3);

  // 締切後はメンバーは回答できない
  assert.equal((await taro.post(`/polls/${pollId}/decide`, { option_id: o2.id })).status, 403);
  const dec = await admin.post(`/polls/${pollId}/decide`, { option_id: o1.id, event: { meet_time: "08:30", opponent: "西町" } });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.poll.status, "decided");
  assert.equal(dec.body.event.date, "2026-11-01");
  assert.equal(dec.body.event.start_time, "09:00");
  assert.equal(dec.body.event.meet_time, "08:30");
  assert.equal(dec.body.event.venue, "市民球場");
  assert.equal(dec.body.event.title, "11月の練習試合");
  const pd = spy.got.find(([n]) => n === "poll.decided");
  assert.equal(pd[1].event.id, dec.body.event.id);
  assert.equal(pd[1].poll.event_id, dec.body.event.id);
  assert.equal((await taro.get(`/events/${dec.body.event.id}`)).status, 200);

  assert.equal((await admin.post(`/polls/${pollId}/decide`, { option_id: o2.id })).status, 409);
  assert.equal((await taro.put(`/polls/${pollId}/answer`, { answers: { [o1.id]: "yes" } })).status, 400);
  assert.equal((await taro.get("/events/pending")).body.polls.length, 0);
});

test("ics: 内容と token 不一致で 404", async () => {
  const { t, admin, taro } = await setup();
  await admin.patch("/settings", { teamName: "常磐ベアーズ" });
  const e1 = (
    await admin.post("/events", {
      date: "2026-10-18",
      opponent: "北町, タイガース",
      meet_time: "07:30",
      start_time: "08:00",
      end_time: "11:00",
      venue: "市民球場; 第2グラウンド",
      belongings: "ユニフォーム（上下）\nスパイク",
      note: "雨天の場合は前日20時に連絡します。駐車場が少ないので乗り合わせでお願いします。よろしくお願いします！",
    })
  ).body.event;
  const e2 = (await admin.post("/events", { date: "2026-10-25", type: "practice" })).body.event;
  const e3 = (await admin.post("/events", { date: "2026-11-01", start_time: "23:00" })).body.event;
  await admin.post(`/events/${e2.id}/cancel`);

  const token = (await taro.get("/settings/ics")).body.token;
  assert.ok(token);
  assert.equal((await t.anon.get(`/ics/wrong${token}`)).status, 404);
  assert.equal((await t.anon.get(`/ics/${token.slice(0, -1)}x`)).status, 404);
  const res = await t.anon.get(`/ics/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/calendar; charset=utf-8");
  const body = res.body;
  assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(body.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(body), "改行は CRLF");
  for (const line of body.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `75オクテット超: ${line}`);
  const unfolded = body.replace(/\r\n /g, "");
  assert.match(unfolded, /X-WR-CALNAME:常磐ベアーズ/);
  assert.match(unfolded, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Tokyo/);
  assert.match(unfolded, /DTSTART;TZID=Asia\/Tokyo:20261018T073000/);
  assert.match(unfolded, /DTEND;TZID=Asia\/Tokyo:20261018T110000/);
  assert.match(unfolded, /SUMMARY:vs 北町\\, タイガース/);
  assert.match(unfolded, /LOCATION:市民球場\\; 第2グラウンド/);
  assert.match(unfolded, /DESCRIPTION:集合: 07:30\\n開始: 08:00〜11:00\\n.*持ち物: ユニフォーム（上下）\\nスパイク/);
  assert.match(unfolded, new RegExp(`UID:event-${e1.id}@`));
  // 終日・中止
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261025\r\nDTEND;VALUE=DATE:20261026/);
  assert.match(unfolded, /SUMMARY:【中止】練習/);
  assert.match(unfolded, /STATUS:CANCELLED/);
  // 日付をまたぐ終了時刻
  assert.match(unfolded, new RegExp(`UID:event-${e3.id}@[^]*?DTEND;TZID=Asia/Tokyo:20261102T020000`));

  // 折り返しは UTF-8 の文字を壊さない
  const long = "DESCRIPTION:" + "あ".repeat(60);
  const folded = icsFold(long);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  for (const l of folded.split("\r\n")) assert.ok(new TextEncoder().encode(l).length <= 75);
});
