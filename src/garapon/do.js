import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_CONFIG,
  LotteryError,
  enter,
  initialState,
  publicBoard,
  spin,
  stats,
} from "./lottery.js";

// 抽選の状態は Durable Object 1個に集約する。
// DO は1リクエストずつ直列に処理されるため、同時に回しても金玉が3個出ることはない。
export class Lottery extends DurableObject {
  async load() {
    return (await this.ctx.storage.get("state")) ?? initialState();
  }

  async save(state) {
    await this.ctx.storage.put("state", state);
  }

  async view(userId) {
    const state = await this.load();
    return {
      stats: stats(state),
      board: publicBoard(state),
      me: userId ? (state.entries[userId] ?? null) : null,
    };
  }

  // LotteryError は RPC 越しに型が失われるので、値として返す
  async guard(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LotteryError) return { error: err.code, message: err.message };
      throw err;
    }
  }

  enter(profile) {
    return this.guard(() => this.#enter(profile));
  }

  spin(userId) {
    return this.guard(() => this.#spin(userId));
  }

  adminConfig(patch) {
    return this.guard(() => this.#adminConfig(patch));
  }

  async #enter(profile) {
    const state = await this.load();
    const { entry } = enter(state, profile);
    // 表示名・アイコンは最新のものに更新
    entry.name = profile.displayName;
    entry.picture = profile.pictureUrl || entry.picture;
    await this.save(state);
    return { stats: stats(state), board: publicBoard(state), me: entry };
  }

  async #spin(userId) {
    const state = await this.load();
    const { entry, created } = spin(state, userId, secureRandom);
    if (created) await this.save(state);
    return { stats: stats(state), board: publicBoard(state), me: entry, fresh: created };
  }

  async adminState() {
    return await this.load();
  }

  async #adminConfig(patch) {
    const state = await this.load();
    const s = stats(state);
    const next = { ...state.config };
    if (patch.total !== undefined) {
      const total = int(patch.total);
      if (total < Math.max(1, s.entries, s.drawn)) {
        throw new LotteryError("bad_config", "玉の数はエントリー人数以上にしてください");
      }
      next.total = total;
    }
    if (patch.prizes !== undefined) next.prizes = int(patch.prizes);
    if (patch.prizeName !== undefined) next.prizeName = String(patch.prizeName).slice(0, 40);
    if (patch.open !== undefined) next.open = Boolean(patch.open);
    const goldDrawn = Object.values(state.entries).filter((e) => e.result?.win).length;
    if (next.prizes < goldDrawn || next.prizes > next.total) {
      throw new LotteryError("bad_config", "当選数の値が不正です");
    }
    state.config = next;
    await this.save(state);
    return state;
  }

  async adminReset(keepEntries) {
    const state = await this.load();
    if (keepEntries) {
      for (const e of Object.values(state.entries)) e.result = null;
    } else {
      state.entries = {};
    }
    state.config = { ...DEFAULT_CONFIG, ...state.config, open: true };
    await this.save(state);
    return state;
  }
}

function int(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new LotteryError("bad_config", "数値が不正です");
  return n;
}

function secureRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}
