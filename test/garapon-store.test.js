import assert from "node:assert/strict";
import test from "node:test";
import { pgliteDb } from "../src/db.js";
import { Lottery } from "../src/garapon/store.js";
import { sharedPglite } from "./helpers/team.js";

test("ガラポン: 19人が同時に回しても当選はちょうど2人（Postgres 上で直列化）", async () => {
  const pg = sharedPglite();
  await pg.exec('CREATE SCHEMA IF NOT EXISTS "garapon_t1"');
  const lottery = new Lottery(pgliteDb(pg, { schema: "garapon_t1" }));
  for (let i = 0; i < 19; i++) {
    const r = await lottery.enter({ userId: `u${i}`, displayName: `user${i}`, pictureUrl: "" });
    assert.equal(r.error, undefined);
  }
  assert.equal((await lottery.enter({ userId: "x", displayName: "x" })).error, "full");
  const results = await Promise.all([...Array(19)].map((_, i) => lottery.spin(`u${i}`)));
  assert.equal(results.filter((r) => r.me.result.win).length, 2);
  const again = await lottery.spin("u0");
  assert.equal(again.fresh, false);
  const view = await lottery.view(null);
  assert.equal(view.stats.remaining, 0);
  assert.equal(view.stats.goldRemaining, 0);
  assert.equal((await lottery.adminConfig({ prizes: 50 })).error, "bad_config");
  const reset = await lottery.adminReset(true);
  assert.equal(Object.values(reset.entries).filter((e) => e.result).length, 0);
});
