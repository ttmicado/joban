// ガラポンの抽選ロジック（純粋関数）。
// 「玉 total 個のうち金玉 prizes 個」の箱から、回すたびに1個ずつ取り出す非復元抽出。
// 誰が何番目に回しても当選確率は prizes / total で等しく、
// 全員が回し終えると当選者はちょうど prizes 人になる。

export const DEFAULT_CONFIG = {
  total: 19, // 玉の数 = 参加人数（LINEグループの人数）
  prizes: 2, // 金玉 = 宿泊券の枚数
  prizeName: "宿泊券",
  open: true, // エントリー受付中か
};

export function initialState() {
  return { config: { ...DEFAULT_CONFIG }, entries: {} };
}

export function stats(state) {
  const list = Object.values(state.entries);
  const drawn = list.filter((e) => e.result).length;
  const goldDrawn = list.filter((e) => e.result?.win).length;
  return {
    total: state.config.total,
    prizes: state.config.prizes,
    prizeName: state.config.prizeName,
    open: state.config.open,
    entries: list.length,
    drawn,
    remaining: state.config.total - drawn,
    goldRemaining: state.config.prizes - goldDrawn,
  };
}

export function enter(state, profile, now = Date.now()) {
  const existing = state.entries[profile.userId];
  if (existing) return { entry: existing, created: false };
  const s = stats(state);
  if (!state.config.open) throw new LotteryError("closed", "エントリー受付は終了しました");
  if (s.entries >= state.config.total) throw new LotteryError("full", "定員に達しました");
  const entry = {
    userId: profile.userId,
    name: profile.displayName,
    picture: profile.pictureUrl || "",
    no: s.entries + 1,
    enteredAt: now,
    result: null,
  };
  state.entries[profile.userId] = entry;
  return { entry, created: true };
}

// random: [0,1) を返す関数
export function spin(state, userId, random, now = Date.now()) {
  const entry = state.entries[userId];
  if (!entry) throw new LotteryError("not_entered", "先にエントリーしてください");
  if (entry.result) return { entry, created: false };
  const s = stats(state);
  if (s.remaining <= 0) throw new LotteryError("empty", "ガラポンの玉がもうありません");
  const win = s.goldRemaining > 0 && random() * s.remaining < s.goldRemaining;
  entry.result = { win, order: s.drawn + 1, at: now };
  return { entry, created: true };
}

export function publicBoard(state) {
  return Object.values(state.entries)
    .sort((a, b) => a.no - b.no)
    .map((e) => ({
      no: e.no,
      name: e.name,
      picture: e.picture,
      status: e.result ? (e.result.win ? "win" : "lose") : "waiting",
    }));
}

export class LotteryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
