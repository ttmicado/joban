// Postgres の薄いラッパー。本番は Neon（node-postgres の Pool）、テスト・ローカルは PGlite で同じ API を提供する。
//
//   await db.all(sql, ...params)  → 行の配列
//   await db.one(sql, ...params)  → 先頭行 or null
//   await db.run(sql, ...params)  → { changes, lastId }（INSERT は自動で RETURNING * し、id 列があれば lastId に入る）
//   await db.exec(sql)            → 複数ステートメントの実行（マイグレーション用・パラメータ無し）
//   await db.tx(async (tx) => …)  → トランザクション。tx も同じ API。入れ子の tx はそのまま外側に参加する
//   await tx.lock(key)            → トランザクション終了まで有効な排他ロック（pg_advisory_xact_lock）
//   await tx.savepoint(async (tx) => …) → 失敗してもその部分だけ取り消す（外側のトランザクションは続行できる）
//
// プレースホルダは SQLite 風の `?` でも Postgres の `$1` でもよい（`?` は自動で `$n` に変換）。
// BIGINT / NUMERIC は JS の number に変換して返す。

const NUMERIC_TYPES = new Set([20, 21, 23, 700, 701, 1700]); // int8, int2, int4, float4, float8, numeric

// 文字列リテラル・引用符付き識別子・コメントの中の ? は変換しない
export function toPg(sql) {
  if (!sql.includes("?")) return sql;
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j);
      i = j - 1;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else out += ch;
  }
  return out;
}

const norm = (params) =>
  params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    if (typeof v === "bigint") return Number(v);
    return v;
  });

function convertRows(result) {
  const numeric = (result.fields || []).filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name);
  return result.rows.map((row) => {
    const out = { ...row };
    for (const k of numeric) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
    for (const k in out) if (typeof out[k] === "bigint") out[k] = Number(out[k]);
    return out;
  });
}

let spSeq = 0;

// query(text, params) → { rows, fields, rowCount } を返す低レベル関数から db を作る
function wrap(query, { tx, execMulti, inTx }) {
  const db = {
    async all(sql, ...params) {
      return convertRows(await query(toPg(sql), norm(params)));
    },
    async one(sql, ...params) {
      return (await db.all(sql, ...params))[0] ?? null;
    },
    async run(sql, ...params) {
      let text = toPg(sql).trim().replace(/;$/, "");
      if (/^insert\b/i.test(text) && !/\breturning\b/i.test(text)) text += " RETURNING *";
      const res = await query(text, norm(params));
      const rows = convertRows(res);
      return { changes: res.rowCount ?? res.affectedRows ?? rows.length, lastId: rows[0]?.id ?? null, rows };
    },
    exec: (sql) => execMulti(sql),
    tx: (fn) => (inTx ? fn(db) : tx(fn)),
    // トランザクション内の一部分を SAVEPOINT で囲む。fn が失敗したらその部分だけ取り消して例外を投げ直す
    // （Postgres はトランザクション内で1文でも失敗すると以降がすべて失敗するため、失敗を許容する処理に使う）
    async savepoint(fn) {
      if (!inTx) return fn(db);
      const name = `sp_${++spSeq}`;
      await query(`SAVEPOINT ${name}`, []);
      try {
        const r = await fn(db);
        await query(`RELEASE SAVEPOINT ${name}`, []);
        return r;
      } catch (err) {
        await query(`ROLLBACK TO SAVEPOINT ${name}`, []);
        throw err;
      }
    },
    async lock(key) {
      if (!inTx) throw new Error("lock() はトランザクション内で呼んでください");
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(key)]);
    },
    inTx,
  };
  return db;
}

// node-postgres の Pool（Neon など）
export function pgDb(pool) {
  const q = (client) => async (text, params) => client.query({ text, values: params });
  return wrap(q(pool), {
    inTx: false,
    execMulti: async (sql) => {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner = wrap(q(client), {
          inTx: true,
          execMulti: async (sql) => {
            await client.query(sql);
          },
        });
        const result = await fn(inner);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  });
}

// PGlite（テスト・ローカル開発用。1接続なので操作は直列化する）
export function pgliteDb(pg, { schema = null } = {}) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  const prefix = async (conn) => {
    if (schema) await conn.query(`SET search_path TO "${schema}"`);
  };
  const runOn = (conn) => async (text, params) => conn.query(text, params);
  return wrap((text, params) => serial(async () => (await prefix(pg), runOn(pg)(text, params))), {
    inTx: false,
    execMulti: (sql) => serial(async () => (await prefix(pg), pg.exec(sql))),
    tx: (fn) =>
      serial(() =>
        pg.transaction(async (conn) => {
          await prefix(conn);
          const inner = wrap(runOn(conn), { inTx: true, execMulti: (sql) => conn.exec(sql) });
          return fn(inner);
        }),
      ),
  });
}
