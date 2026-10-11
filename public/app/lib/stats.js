// 野球成績の計算（フロントエンドとサーバーの両方から import する純粋関数）

export const BATTING_FIELDS = [
  ["pa", "打席"],
  ["ab", "打数"],
  ["h", "安打"],
  ["d2", "二塁打"],
  ["d3", "三塁打"],
  ["hr", "本塁打"],
  ["rbi", "打点"],
  ["r", "得点"],
  ["so", "三振"],
  ["bb", "四球"],
  ["hbp", "死球"],
  ["sh", "犠打"],
  ["sf", "犠飛"],
  ["sb", "盗塁"],
  ["e", "失策"],
];

export const PITCHING_FIELDS = [
  ["outs", "アウト数"],
  ["bf", "打者"],
  ["pitches", "球数"],
  ["h", "被安打"],
  ["hr", "被本塁打"],
  ["so", "奪三振"],
  ["bb", "与四球"],
  ["hbp", "与死球"],
  ["r", "失点"],
  ["er", "自責点"],
];

const sum = (rows, keys) => {
  const t = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) for (const k of keys) t[k] += Number(r[k]) || 0;
  return t;
};

const div = (a, b) => (b > 0 ? a / b : null);

// 1試合分の打撃成績の矛盾チェック。問題があればメッセージの配列を返す
export function validateBatting(b) {
  const errs = [];
  const n = (k) => Number(b[k]) || 0;
  if (n("h") > n("ab")) errs.push("安打が打数より多くなっています");
  if (n("d2") + n("d3") + n("hr") > n("h")) errs.push("長打（二塁打・三塁打・本塁打）が安打より多くなっています");
  if (n("so") > n("ab")) errs.push("三振が打数より多くなっています");
  if (n("ab") + n("bb") + n("hbp") + n("sh") + n("sf") > n("pa")) errs.push("打数・四死球・犠打飛の合計が打席を超えています");
  return errs;
}

export function battingTotals(rows) {
  const t = sum(rows, BATTING_FIELDS.map(([k]) => k));
  t.games = new Set(rows.map((r) => r.game_id ?? r.gameId)).size || rows.length;
  return t;
}

// 打率・出塁率・長打率・OPS など
export function battingRates(t) {
  const singles = t.h - t.d2 - t.d3 - t.hr;
  const tb = singles + 2 * t.d2 + 3 * t.d3 + 4 * t.hr;
  const avg = div(t.h, t.ab);
  const obp = div(t.h + t.bb + t.hbp, t.ab + t.bb + t.hbp + t.sf);
  const slg = div(tb, t.ab);
  return {
    avg,
    obp,
    slg,
    ops: obp === null || slg === null ? null : obp + slg,
    tb,
    isoP: slg === null || avg === null ? null : slg - avg,
    kRate: div(t.so, t.pa),
    bbRate: div(t.bb, t.pa),
  };
}

export function pitchingTotals(rows) {
  const t = sum(rows, PITCHING_FIELDS.map(([k]) => k));
  t.games = new Set(rows.map((r) => r.game_id ?? r.gameId)).size || rows.length;
  t.w = rows.filter((r) => r.decision === "W").length;
  t.l = rows.filter((r) => r.decision === "L").length;
  t.sv = rows.filter((r) => r.decision === "S").length;
  t.hld = rows.filter((r) => r.decision === "H").length;
  return t;
}

// innings: 防御率などの基準イニング（草野球は7回が多いので設定値を渡す）
export function pitchingRates(t, innings = 7) {
  const ip = t.outs / 3;
  return {
    ip,
    era: div(t.er * innings, ip),
    whip: div(t.bb + t.h, ip),
    k9: div(t.so * innings, ip), // 「innings 回あたり奪三振」
    bb9: div(t.bb * innings, ip),
    kbb: div(t.so, t.bb),
    winPct: div(t.w, t.w + t.l),
  };
}

// --- 表示用 ---------------------------------------------------------------

// .333 形式（1.000 はそのまま）
export function fmtRate(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  const s = x.toFixed(3);
  return x < 1 ? s.replace(/^0/, "") : s;
}

// 防御率など小数2桁
export function fmtNum(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return x.toFixed(digits);
}

// アウト数 → 投球回 "5 2/3"
export function fmtIP(outs) {
  const whole = Math.floor(outs / 3);
  const rest = outs % 3;
  return rest ? `${whole} ${rest}/3` : String(whole);
}

export function gameResult(g) {
  if (g.our_score === null || g.our_score === undefined || g.their_score === null || g.their_score === undefined) return null;
  return g.our_score > g.their_score ? "win" : g.our_score < g.their_score ? "lose" : "draw";
}

export const RESULT_LABEL = { win: "勝", lose: "敗", draw: "分" };
