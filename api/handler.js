// Vercel Functions の入口。vercel.json の rewrite で /api/* と /ics/* がすべてここに来る。
// DB は Neon（Postgres）。接続文字列は環境変数 DATABASE_URL（Vercel の Neon 連携で自動設定される）。
import pg from "pg";
import { pgDb } from "../src/db.js";
import { createServer } from "../src/server.js";

// BIGINT / NUMERIC を文字列ではなく number で受け取る
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

let server = null;
function getServer() {
  if (server) return server;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL が設定されていません");
  // サーバーレスなので1インスタンスあたりの接続は少なく。Neon の pooler（-pooler の付いた URL）を推奨
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error("pg pool error", err));
  server = createServer({ env: process.env, db: pgDb(pool) });
  return server;
}

const handle = (request) => getServer().fetch(request);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
