import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";

test("最初に参加した人が管理者・2人目以降はメンバー", async () => {
  const t = makeTeam();
  const a = await t.join("監督", { number: "30", positions: ["投", "一"] });
  const b = await t.join("太郎");
  assert.equal(a.member.role, "admin");
  assert.deepEqual(a.member.positions, ["投", "一"]);
  assert.equal(b.member.role, "member");
  assert.equal((await b.post("/join", { name: "x" })).status, 409);
});

test("未参加・未ログインのアクセス制御", async () => {
  const t = makeTeam();
  assert.equal((await t.anon.get("/members")).status, 401);
  const u = t.user("新人");
  assert.equal((await u.get("/members")).status, 403);
  const me = await u.get("/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.member, null);
  assert.equal(me.body.firstMember, true);
});

test("助っ人追加・権限変更・最後の管理者は外せない", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const b = await t.join("太郎");
  assert.equal((await b.post("/members", { name: "助っ人" })).status, 403);
  const g = await a.post("/members", { name: "助っ人", number: "99" });
  assert.equal(g.body.member.isGuest, true);
  assert.equal((await a.patch(`/members/${a.member.id}`, { role: "member" })).status, 400);
  assert.equal((await a.patch(`/members/${b.member.id}`, { role: "admin" })).body.member.role, "admin");
  assert.equal((await b.patch(`/members/${a.member.id}`, { name: "監督2" })).status, 200);
  const list = await a.get("/members");
  assert.equal(list.body.members.length, 3);
  assert.equal((await a.patch("/settings", { teamName: "常磐ベアーズ" })).body.settings.teamName, "常磐ベアーズ");
  assert.equal((await b.get("/settings")).body.settings.teamName, "常磐ベアーズ");
});
