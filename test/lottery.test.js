import assert from "node:assert/strict";
import test from "node:test";
import { enter, initialState, spin, stats } from "../src/lottery.js";

const join = (state, n) => {
  for (let i = 0; i < n; i++) enter(state, { userId: `u${i}`, displayName: `user${i}` });
};

test("19人全員が回すと当選はちょうど2人", () => {
  for (let round = 0; round < 500; round++) {
    const state = initialState();
    join(state, 19);
    for (let i = 0; i < 19; i++) spin(state, `u${i}`, Math.random);
    const s = stats(state);
    assert.equal(s.remaining, 0);
    assert.equal(s.goldRemaining, 0);
    assert.equal(Object.values(state.entries).filter((e) => e.result.win).length, 2);
  }
});

test("回す順番によらず当選確率は 2/19", () => {
  const N = 40000;
  const wins = Array(19).fill(0);
  for (let r = 0; r < N; r++) {
    const state = initialState();
    join(state, 19);
    for (let i = 0; i < 19; i++) if (spin(state, `u${i}`, Math.random).entry.result.win) wins[i]++;
  }
  for (const w of wins) assert.ok(Math.abs(w / N - 2 / 19) < 0.012, `rate ${w / N}`);
});

test("2回目は同じ結果を返し、玉は減らない", () => {
  const state = initialState();
  join(state, 3);
  const first = spin(state, "u0", () => 0).entry.result;
  const again = spin(state, "u0", () => 0.99);
  assert.equal(again.created, false);
  assert.deepEqual(again.entry.result, first);
  assert.equal(stats(state).drawn, 1);
});

test("エントリーなしでは回せない・定員を超えてエントリーできない", () => {
  const state = initialState();
  assert.throws(() => spin(state, "nobody", Math.random), { code: "not_entered" });
  join(state, 19);
  assert.throws(() => enter(state, { userId: "x", displayName: "x" }), { code: "full" });
  assert.equal(enter(state, { userId: "u3", displayName: "u3" }).created, false);
});
