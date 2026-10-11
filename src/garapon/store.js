import { DEFAULT_CONFIG, LotteryError, enter, initialState, publicBoard, spin, stats } from "./lottery.js";

// ガラポンの状態は Postgres の1行（JSON）に保存する。
// 変更は排他ロック付きのトランザクションで直列に処理するので、同時に回しても金玉が3個出ることはない。
export class Lottery {
  #ready = null;

  constructor(db) {
    this.db = db;
  }

  #migrate() {
    this.#ready ??= this.db
      .exec("CREATE TABLE IF NOT EXISTS garapon_state (id BIGINT PRIMARY KEY, state TEXT NOT NULL)")
      .catch((err) => {
        this.#ready = null;
        throw err;
      });
    return this.#ready;
  }

  // fn(state) の戻り値を返す。save が true なら状態を保存する
  async #withState(fn, { write = true } = {}) {
    await this.#migrate();
    return this.db.tx(async (tx) => {
      if (write) await tx.lock("garapon");
      const row = await tx.one("SELECT state FROM garapon_state WHERE id = 1");
      const state = row ? JSON.parse(row.state) : initialState();
      const { result, save = write } = await fn(state);
      if (save) {
        await tx.run(
          "INSERT INTO garapon_state(id, state) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
          JSON.stringify(state),
        );
      }
      return result;
    });
  }

  // LotteryError は { error, message } の値として返す
  async #guard(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LotteryError) return { error: err.code, message: err.message };
      throw err;
    }
  }

  view(userId) {
    return this.#withState(
      (state) => ({
        result: {
          stats: stats(state),
          board: publicBoard(state),
          me: userId ? (state.entries[userId] ?? null) : null,
        },
      }),
      { write: false },
    );
  }

  enter(profile) {
    return this.#guard(() =>
      this.#withState((state) => {
        const { entry } = enter(state, profile);
        // 表示名・アイコンは最新のものに更新
        entry.name = profile.displayName;
        entry.picture = profile.pictureUrl || entry.picture;
        return { result: { stats: stats(state), board: publicBoard(state), me: entry } };
      }),
    );
  }

  spin(userId) {
    return this.#guard(() =>
      this.#withState((state) => {
        const { entry, created } = spin(state, userId, secureRandom);
        return {
          save: created,
          result: { stats: stats(state), board: publicBoard(state), me: entry, fresh: created },
        };
      }),
    );
  }

  adminState() {
    return this.#withState((state) => ({ result: state }), { write: false });
  }

  adminConfig(patch) {
    return this.#guard(() =>
      this.#withState((state) => {
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
        return { result: state };
      }),
    );
  }

  adminReset(keepEntries) {
    return this.#withState((state) => {
      if (keepEntries) {
        for (const e of Object.values(state.entries)) e.result = null;
      } else {
        state.entries = {};
      }
      state.config = { ...DEFAULT_CONFIG, ...state.config, open: true };
      return { result: state };
    });
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
