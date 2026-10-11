import assert from "node:assert/strict";
import test from "node:test";
import { battingRates, battingTotals, fmtIP, fmtRate, pitchingRates, pitchingTotals, validateBatting } from "../public/app/lib/stats.js";

test("打率・出塁率・長打率・OPS", () => {
  const t = battingTotals([
    { game_id: 1, pa: 4, ab: 3, h: 2, d2: 1, hr: 1, bb: 1 },
    { game_id: 2, pa: 4, ab: 4, h: 1, so: 2 },
  ]);
  const r = battingRates(t);
  assert.equal(t.games, 2);
  assert.equal(fmtRate(r.avg), ".429");
  assert.equal(fmtRate(r.obp), ".500");
  assert.equal(r.tb, 1 + 2 + 4);
  assert.equal(fmtRate(r.slg), "1.000");
  assert.equal(fmtRate(battingRates(battingTotals([])).avg), "-");
});

test("防御率は規定イニング基準・投球回表示", () => {
  const t = pitchingTotals([
    { game_id: 1, outs: 14, er: 2, so: 5, bb: 2, h: 4, decision: "W" },
    { game_id: 2, outs: 7, er: 1, decision: "L" },
  ]);
  const r = pitchingRates(t, 7);
  assert.equal(fmtIP(t.outs), "7");
  assert.equal(fmtIP(14), "4 2/3");
  assert.equal(r.era, 3);
  assert.equal(t.w, 1);
  assert.equal(t.l, 1);
});

test("打撃成績の矛盾チェック", () => {
  assert.deepEqual(validateBatting({ pa: 4, ab: 3, h: 1, bb: 1 }), []);
  assert.equal(validateBatting({ pa: 3, ab: 3, h: 4 }).length, 1);
});
