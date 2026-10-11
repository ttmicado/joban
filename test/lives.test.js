import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";

const LIVE = { title: "アミダライン単独ライブ", date: "2026-11-03", open_time: "18:30", start_time: "19:00", venue: "新宿バティオス", price_advance: 2000, price_door: 2500, price_note: "別途1ドリンク" };

test("ライブの登録と一覧・詳細（場所・時間・料金）", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("水上");
  const yamaguchi = await t.join("山口 陽常");
  const r = await yamaguchi.post("/lives", LIVE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = r.body.live;
  assert.equal(l.performer, "アミダライン");
  assert.equal(l.venue, "新宿バティオス");
  assert.equal(l.startTime, "19:00");
  assert.equal(l.priceAdvance, 2000);
  assert.equal(l.canEdit, true);
  const list = await admin.get("/lives");
  const mine = list.body.lives.find((x) => x.id === l.id);
  assert.equal(mine.counts.unanswered, 2);
  assert.equal(list.body.canPost, true);
  assert.equal((await admin.post("/lives", { ...LIVE, venue: "" })).status, 400);
  assert.equal((await admin.post("/lives", { ...LIVE, price_advance: -1 })).status, 400);
});

test("参加意思（行く・取り置き枚数・迷い中・行けない）と代理回答", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("水上");
  const kawamura = await t.join("河村");
  const tashiro = await t.join("田代");
  const id = (await admin.post("/lives", LIVE)).body.live.id;
  let r = await kawamura.put(`/lives/${id}/rsvp`, { status: "go", tickets: 2, comment: "嫁と行きます" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.live.my, { status: "go", tickets: 2, comment: "嫁と行きます" });
  await tashiro.put(`/lives/${id}/rsvp`, { status: "maybe" });
  r = await kawamura.put(`/lives/${id}/rsvp`, { status: "go", tickets: 3 });
  const live = (await admin.get(`/lives/${id}`)).body.live;
  assert.deepEqual(live.counts, { go: 1, maybe: 1, no: 0, unanswered: 1, tickets: 3 });
  assert.equal(live.rsvps.find((x) => x.member.name === "河村").tickets, 3);
  // 行けない場合は取り置きなし
  r = await tashiro.put(`/lives/${id}/rsvp`, { status: "no", tickets: 5 });
  assert.equal(r.body.live.my.tickets, 0);
  // 代理: 管理者は可、一般メンバーは他人の分は不可
  assert.equal((await admin.put(`/lives/${id}/rsvp`, { status: "go", member_id: tashiro.member.id })).status, 200);
  assert.equal((await kawamura.put(`/lives/${id}/rsvp`, { status: "no", member_id: tashiro.member.id })).status, 403);
  assert.equal((await kawamura.put(`/lives/${id}/rsvp`, { status: "yes" })).status, 400);
  // 取り消し
  r = await kawamura.del(`/lives/${id}/rsvp`);
  assert.equal(r.body.live.my, null);
});

test("編集・中止・削除は登録者か管理者だけ", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("水上");
  const wake = await t.join("和氣　達朗");
  const other = await t.join("戸部");
  const id = (await wake.post("/lives", LIVE)).body.live.id;
  assert.equal((await other.patch(`/lives/${id}`, { title: "x" })).status, 403);
  assert.equal((await other.post("/lives", LIVE)).status, 403);
  assert.equal((await other.get("/lives")).body.canPost, false);
  assert.equal((await wake.patch(`/lives/${id}`, { price_door: 3000 })).body.live.priceDoor, 3000);
  assert.equal((await admin.patch(`/lives/${id}`, { status: "canceled" })).body.live.status, "canceled");
  assert.equal((await other.put(`/lives/${id}/rsvp`, { status: "go" })).status, 400);
  assert.equal((await other.del(`/lives/${id}`)).status, 403);
  assert.equal((await wake.del(`/lives/${id}`)).status, 200);
  assert.equal((await admin.get(`/lives/${id}`)).status, 404);
});

test("公開済みの10月のスケジュールが最初から入っている（地図URL付き）", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("水上");
  const past = (await admin.get("/lives?range=past")).body.lives;
  const upcoming = (await admin.get("/lives")).body.lives;
  assert.equal(past.length + upcoming.length, 8);
  const m1 = upcoming.find((x) => x.title === "M-1グランプリ二回戦");
  assert.equal(m1.venue, "浅草雷5656会館");
  assert.equal(m1.startTime, "");
  assert.match(m1.venueUrl, /^https:\/\/www\.google\.com\/maps\/search\//);
  assert.equal(past.find((x) => x.date === "2026-10-02").startTime, "20:00");
  assert.ok(upcoming.every((x) => x.performer === "アミダライン"));
});

test("ライブ登録の権限: アミダラインと管理者、管理者が許可した人", async () => {
  const t = makeTeam({ now: "2026-10-11T12:00" });
  const admin = await t.join("水上");
  const kawamura = await t.join("河村");
  assert.equal((await kawamura.post("/lives", LIVE)).status, 403);
  assert.equal((await kawamura.put(`/lives/posters/${kawamura.member.id}`, { allowed: true })).status, 403);
  assert.equal((await admin.put(`/lives/posters/${kawamura.member.id}`, { allowed: true })).status, 200);
  assert.equal((await kawamura.post("/lives", LIVE)).status, 200);
  const posters = (await admin.get("/lives/posters")).body.members;
  assert.equal(posters.find((m) => m.id === kawamura.member.id).canPostLives, true);
  await admin.put(`/lives/posters/${kawamura.member.id}`, { allowed: false });
  assert.equal((await kawamura.post("/lives", LIVE)).status, 403);
});
