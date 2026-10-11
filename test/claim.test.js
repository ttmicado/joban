// 取り込んだ（LINE 未連携の）選手への LINE 紐付け・メンバー統合
import assert from "node:assert/strict";
import test from "node:test";
import { makeTeam } from "./helpers/team.js";

const NOW = Date.UTC(2026, 9, 11);

async function addPlayer(t, name, { number = null, positions = "", active = 1, guest = 0, throws = null, bats = null } = {}) {
  const { lastId } = await t.db.run(
    "INSERT INTO members(name, number, positions, throws, bats, is_guest, active, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    name,
    number,
    positions,
    throws,
    bats,
    guest,
    active,
    NOW,
  );
  return lastId;
}

async function addGame(t, date = "2025-05-01", opponent = "相手") {
  const { lastId } = await t.db.run(
    "INSERT INTO games(season, date, opponent, status, created_at, updated_at) VALUES(?, ?, ?, 'final', ?, ?)",
    Number(date.slice(0, 4)),
    date,
    opponent,
    NOW,
    NOW,
  );
  return lastId;
}

const bat = (t, gameId, memberId, h = 1, ab = 3) =>
  t.db.run("INSERT INTO batting(game_id, member_id, pa, ab, h, updated_at) VALUES(?, ?, ?, ?, ?, ?)", gameId, memberId, ab, ab, h, NOW);
const pit = (t, gameId, memberId, outs = 9) =>
  t.db.run("INSERT INTO pitching(game_id, member_id, outs, updated_at) VALUES(?, ?, ?, ?)", gameId, memberId, outs, NOW);

test("候補一覧: 未連携・助っ人以外だけ。退団者は区別・試合数つき", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const p1 = await addPlayer(t, "山田 太郎", { number: "7", positions: "遊,二" });
  const p2 = await addPlayer(t, "佐藤次郎", { active: 0 });
  await addPlayer(t, "助っ人A", { guest: 1 });
  const g1 = await addGame(t, "2024-04-01");
  const g2 = await addGame(t, "2025-06-01");
  await bat(t, g1, p1);
  await bat(t, g2, p1);
  await pit(t, g2, p1);

  const u = t.user("新人");
  const res = await u.get("/join/candidates");
  assert.equal(res.status, 200);
  const list = res.body.candidates;
  assert.deepEqual(list.map((x) => x.name), ["山田 太郎", "佐藤次郎"]);
  const yamada = list.find((x) => x.id === p1);
  assert.equal(yamada.games, 2);
  assert.equal(yamada.firstYear, 2024);
  assert.equal(yamada.lastYear, 2025);
  assert.deepEqual(yamada.positions, ["遊", "二"]);
  assert.equal(yamada.retired, false);
  assert.equal(list.find((x) => x.id === p2).retired, true);
  assert.ok(!list.some((x) => x.id === a.member.id));
  // 未ログインは不可
  assert.equal((await t.anon.get("/join/candidates")).status, 401);
});

test("claim で参加: 成績が引き継がれ、最初の連携者は管理者", async () => {
  const t = makeTeam();
  const p1 = await addPlayer(t, "監督", { number: "30", positions: "投", throws: "右", bats: "右" });
  const p2 = await addPlayer(t, "退団した人", { active: 0 });
  const g = await addGame(t);
  await bat(t, g, p1, 2, 4);

  const u = t.user("LINE監督");
  const me0 = await u.get("/me");
  assert.equal(me0.body.firstMember, true);
  const res = await u.post("/join", { claimMemberId: p1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.member.id, p1);
  assert.equal(res.body.member.role, "admin");
  assert.equal(res.body.member.linked, true);
  assert.equal(res.body.member.name, "監督"); // 名前未入力なら取り込んだ名前のまま
  assert.equal(res.body.member.number, "30");
  assert.equal(res.body.claimed, true);
  const me = await u.get("/me");
  assert.equal(me.body.member.id, p1);
  const career = await u.get(`/stats/players/${p1}`);
  assert.equal(career.status, 200);

  // 2人目: 退団者を選ぶと在籍に戻る・名前を入力すれば更新・管理者にはならない
  const v = t.user("ジロー");
  const r2 = await v.post("/join", { claimMemberId: p2, name: "次郎", number: "" });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.member.role, "member");
  assert.equal(r2.body.member.active, true);
  assert.equal(r2.body.member.name, "次郎");

  // 候補から消える
  const cand = await t.user("x").get("/join/candidates");
  assert.equal(cand.body.candidates.length, 0);
});

test("連携済み・助っ人・存在しない選手は claim できない", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const guest = await addPlayer(t, "助っ人", { guest: 1 });
  const p = await addPlayer(t, "選手");
  assert.equal((await t.user("u1").post("/join", { claimMemberId: a.member.id })).status, 409);
  assert.equal((await t.user("u2").post("/join", { claimMemberId: guest })).status, 400);
  assert.equal((await t.user("u3").post("/join", { claimMemberId: 99999 })).status, 404);
  assert.equal((await t.user("u4").post("/join", { claimMemberId: p })).status, 200);
  assert.equal((await t.user("u5").post("/join", { claimMemberId: p })).status, 409);
  // 参加済みの人は claim できない
  assert.equal((await a.post("/join", { claimMemberId: p })).status, 409);
});

test("/me/merge: 成績・出欠・練習などが付け替わり、X は消える。衝突は自分の行を残す", async () => {
  const t = makeTeam();
  const a = await t.join("監督"); // プロフィール空欄
  const b = await t.join("太郎");
  const x = await addPlayer(t, "監督（過去）", { number: "30", positions: "投,一", throws: "右", bats: "左" });
  const g1 = await addGame(t, "2024-04-01");
  const g2 = await addGame(t, "2024-05-01");
  await bat(t, g1, x, 1, 3);
  await bat(t, g2, x, 3, 4); // 衝突: 自分も g2 に成績あり
  await bat(t, g2, a.member.id, 0, 2);
  await pit(t, g1, x, 12);
  await t.db.run("INSERT INTO games_at_bats(game_id, member_id, seq, result) VALUES(?, ?, 1, 'single'), (?, ?, 1, 'so'), (?, ?, 1, 'go')", g1, x, g2, x, g2, a.member.id);
  await t.db.run("UPDATE games SET mvp_member_id = ? WHERE id = ?", x, g1);
  const { lastId: ev } = await t.db.run(
    "INSERT INTO events(title, date, created_by, created_at, updated_at) VALUES('練習試合', '2026-10-20', ?, ?, ?)",
    x,
    NOW,
    NOW,
  );
  await t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, 'yes', ?)", ev, x, NOW);
  const { lastId: pr } = await t.db.run("INSERT INTO practices(member_id, date, created_at, updated_at) VALUES(?, '2026-10-01', ?, ?)", x, NOW, NOW);
  const { lastId: pr2 } = await t.db.run("INSERT INTO practices(member_id, date, created_at, updated_at) VALUES(?, '2026-10-02', ?, ?)", b.member.id, NOW, NOW);
  await t.db.run("INSERT INTO practice_likes(practice_id, member_id, at) VALUES(?, ?, ?), (?, ?, ?)", pr2, x, NOW, pr2, a.member.id, NOW);
  await t.db.run("INSERT INTO practice_likes(practice_id, member_id, at) VALUES(?, ?, ?)", pr, b.member.id, NOW);

  // 一般メンバーは連携済みの人を自分に統合できない
  assert.equal((await b.post("/me/merge", { memberId: a.member.id })).status, 409);
  assert.equal((await a.post("/me/merge", { memberId: a.member.id })).status, 400);

  const res = await a.post("/me/merge", { memberId: x });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const me = res.body.member;
  assert.equal(me.id, a.member.id);
  assert.equal(me.name, "監督"); // 名前は変えない
  assert.equal(me.number, "30");
  assert.deepEqual(me.positions, ["投", "一"]);
  assert.equal(me.throws, "右");
  assert.equal(me.bats, "左");
  assert.equal(me.role, "admin");

  assert.equal(await t.db.one("SELECT * FROM members WHERE id = ?", x), null);
  for (const tbl of ["batting", "pitching", "games_at_bats", "attendance", "practices", "practice_likes"]) {
    assert.equal((await t.db.one(`SELECT COUNT(*) AS n FROM ${tbl} WHERE member_id = ?`, x)).n, 0, tbl);
  }
  const batRows = await t.db.all("SELECT game_id, h FROM batting WHERE member_id = ? ORDER BY game_id", a.member.id);
  assert.deepEqual(batRows, [
    { game_id: g1, h: 1 },
    { game_id: g2, h: 0 }, // 自分の行が残る
  ]);
  const abs = await t.db.all("SELECT game_id, result FROM games_at_bats WHERE member_id = ? ORDER BY game_id", a.member.id);
  assert.deepEqual(abs, [
    { game_id: g1, result: "single" },
    { game_id: g2, result: "go" },
  ]);
  assert.equal((await t.db.one("SELECT COUNT(*) AS n FROM pitching WHERE member_id = ?", a.member.id)).n, 1);
  assert.equal((await t.db.one("SELECT mvp_member_id FROM games WHERE id = ?", g1)).mvp_member_id, a.member.id);
  assert.equal((await t.db.one("SELECT created_by FROM events WHERE id = ?", ev)).created_by, a.member.id);
  assert.equal((await t.db.one("SELECT member_id FROM attendance WHERE event_id = ?", ev)).member_id, a.member.id);
  assert.equal((await t.db.one("SELECT member_id FROM practices WHERE id = ?", pr)).member_id, a.member.id);
  // いいねの衝突（両方が同じ投稿にいいね）は1件に
  assert.equal((await t.db.one("SELECT COUNT(*) AS n FROM practice_likes WHERE practice_id = ?", pr2)).n, 1);

  // useName で名前を過去データのものに
  const y = await addPlayer(t, "タロウ（過去）");
  const r2 = await b.post("/me/merge", { memberId: y, useName: true });
  assert.equal(r2.body.member.name, "タロウ（過去）");
  // 助っ人は統合できない
  const g = await addPlayer(t, "助っ人", { guest: 1 });
  assert.equal((await b.post("/me/merge", { memberId: g })).status, 400);
});

test("管理者の統合: 誤って新規登録した人を過去の選手に統合（LINE 連携が移る）", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const b = await t.join("たろう", { number: "5" });
  const x = await addPlayer(t, "山田太郎", { number: "7" });
  const g = await addGame(t);
  await bat(t, g, x);
  const { lastId: ev } = await t.db.run("INSERT INTO events(title, date, created_at, updated_at) VALUES('試合', '2026-10-20', ?, ?)", NOW, NOW);
  await t.db.run("INSERT INTO attendance(event_id, member_id, status, updated_at) VALUES(?, ?, 'yes', ?)", ev, b.member.id, NOW);

  // 一般メンバーは不可
  assert.equal((await b.post(`/members/${b.member.id}/merge`, { intoId: x })).status, 403);
  // 両方連携済みは不可
  assert.equal((await a.post(`/members/${b.member.id}/merge`, { intoId: a.member.id })).status, 400);
  assert.equal((await a.post(`/members/${x}/merge`, { intoId: x })).status, 400);

  const res = await a.post(`/members/${b.member.id}/merge`, { intoId: x });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.member.id, x);
  assert.equal(res.body.member.linked, true);
  assert.equal(res.body.member.name, "山田太郎");
  assert.equal(res.body.member.number, "7"); // 統合先の値を優先
  // b の LINE アカウントでログインすると x になっている
  const me = await b.get("/me");
  assert.equal(me.body.member.id, x);
  assert.equal((await t.db.one("SELECT member_id FROM attendance WHERE event_id = ?", ev)).member_id, x);
  assert.equal(await t.db.one("SELECT * FROM members WHERE id = ?", b.member.id), null);

  // 未連携同士の統合（重複して取り込まれた選手）
  const y1 = await addPlayer(t, "鈴木");
  const y2 = await addPlayer(t, "鈴木一郎");
  const g2 = await addGame(t, "2023-01-01");
  await pit(t, g2, y1);
  const r2 = await a.post(`/members/${y1}/merge`, { intoId: y2 });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.member.linked, false);
  assert.equal((await t.db.one("SELECT member_id FROM pitching WHERE game_id = ?", g2)).member_id, y2);
});

test("管理者の LINE 連携解除: 未連携に戻り、再度 claim できる。自分・最後の管理者・一般メンバーは不可", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const x = await addPlayer(t, "山田");
  const g = await addGame(t);
  await bat(t, g, x);
  const wrong = t.user("間違えた人");
  assert.equal((await wrong.post("/join", { claimMemberId: x })).status, 200);
  const other = await t.join("別の人");

  // 一般メンバーは解除できない（自分の分も、他人の分も）
  assert.equal((await other.patch(`/members/${x}`, { unlinkLine: true })).status, 403);
  assert.equal((await wrong.patch(`/members/${x}`, { unlinkLine: true })).status, 200); // 本人の編集では管理者専用項目は無視される
  assert.equal((await wrong.get("/me")).body.member.id, x);
  // 自分自身は不可
  assert.equal((await a.patch(`/members/${a.member.id}`, { unlinkLine: true })).status, 400);

  const res = await a.patch(`/members/${x}`, { unlinkLine: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.member.linked, false);
  assert.equal(res.body.member.role, "member");
  assert.equal((await wrong.get("/me")).body.member, null);
  // 成績は残り、候補に戻る
  assert.equal((await t.db.one("SELECT COUNT(*) AS n FROM batting WHERE member_id = ?", x)).n, 1);
  const cand = await wrong.get("/join/candidates");
  assert.ok(cand.body.candidates.some((c) => c.id === x));
  // 正しい人が claim
  const right = t.user("山田本人");
  assert.equal((await right.post("/join", { claimMemberId: x })).body.member.id, x);
  // 間違えた人は新規で参加できる
  assert.equal((await wrong.post("/join", { name: "間違えた人" })).status, 200);

  // 無効化済みの管理者の連携解除は、在籍中の管理者数に関係なくできる
  await a.patch(`/members/${other.member.id}`, { role: "admin" });
  await a.patch(`/members/${other.member.id}`, { active: false });
  assert.equal((await a.patch(`/members/${other.member.id}`, { unlinkLine: true })).status, 200);
});

test("最後の管理者の LINE 連携は外せない", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const b = await t.join("コーチ");
  await a.patch(`/members/${b.member.id}`, { role: "admin" });
  // b が a を外すのは OK（b が残る）
  assert.equal((await b.patch(`/members/${a.member.id}`, { unlinkLine: true })).status, 200);
  // a は未連携に戻り管理者でもなくなる → 管理者は b だけ。b 自身の解除は不可（最後の管理者が残る）
  assert.equal((await b.patch(`/members/${b.member.id}`, { unlinkLine: true })).status, 400);
  assert.equal((await a.get("/me")).body.member, null);
  const admins = (await t.db.one("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1")).n;
  assert.equal(admins, 1);
});

test("役職（title）: 本人・管理者が編集でき、候補一覧・統合で引き継がれる。管理者権限にはならない", async () => {
  const t = makeTeam();
  const a = await t.join("監督");
  const b = await t.join("太郎");
  assert.equal(a.member.title, "");
  const r = await b.patch("/me", { title: "キャプテン / GM" });
  assert.equal(r.body.member.title, "キャプテン / GM");
  assert.equal(r.body.member.role, "member");
  assert.equal((await b.patch("/me", { title: "あ".repeat(31) })).status, 400);
  assert.equal((await a.patch(`/members/${b.member.id}`, { title: "副キャプテン" })).body.member.title, "副キャプテン");
  assert.equal((await b.patch("/me", { title: "" })).body.member.title, "");

  const x = await addPlayer(t, "水上 裕太");
  await t.db.run("UPDATE members SET title = '監督' WHERE id = ?", x);
  const cand = await t.user("u").get("/join/candidates");
  assert.equal(cand.body.candidates[0].title, "監督");
  const m = await a.post("/me/merge", { memberId: x });
  assert.equal(m.body.member.title, "監督");
  // claim 時に空欄の title を送っても取り込んだ値は消えない
  const y = await addPlayer(t, "河村");
  await t.db.run("UPDATE members SET title = 'GM' WHERE id = ?", y);
  const j = await t.user("河村").post("/join", { claimMemberId: y, title: "" });
  assert.equal(j.body.member.title, "GM");
});
