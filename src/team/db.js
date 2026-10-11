// SQLite の薄いラッパー。Durable Object の ctx.storage.sql と node:sqlite（テスト用）の両方で同じ API を提供する。
//   db.all(sql, ...params)  → 行の配列
//   db.one(sql, ...params)  → 先頭行 or null
//   db.run(sql, ...params)  → { changes, lastId }
//   db.tx(fn)               → fn をトランザクション内で同期実行
//   db.exec(sql)            → 複数ステートメントの実行（マイグレーション用）

const norm = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

const plain = (row) => (row ? { ...row } : null);

export function durableDb(storage) {
  const sql = storage.sql;
  return {
    all: (q, ...p) => sql.exec(q, ...norm(p)).toArray().map(plain),
    one: (q, ...p) => plain(sql.exec(q, ...norm(p)).toArray()[0]),
    run(q, ...p) {
      const cur = sql.exec(q, ...norm(p));
      cur.toArray();
      const lastId = sql.exec("SELECT last_insert_rowid() AS id").one().id;
      return { changes: cur.rowsWritten, lastId };
    },
    tx: (fn) => storage.transactionSync(fn),
    exec(q) {
      // ctx.storage.sql.exec は複数ステートメントを受け付ける
      sql.exec(q).toArray();
    },
  };
}

export function nodeDb(database) {
  return {
    all: (q, ...p) => database.prepare(q).all(...norm(p)).map(plain),
    one: (q, ...p) => plain(database.prepare(q).get(...norm(p))),
    run(q, ...p) {
      const r = database.prepare(q).run(...norm(p));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    tx(fn) {
      database.exec("BEGIN");
      try {
        const r = fn();
        database.exec("COMMIT");
        return r;
      } catch (e) {
        database.exec("ROLLBACK");
        throw e;
      }
    },
    exec: (q) => database.exec(q),
  };
}
