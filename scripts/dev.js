// ローカル開発サーバー: public/ の静的ファイルと API を1つのポートで配信する。
//   node scripts/dev.js [--port 3000] [--data .data/dev]
// DB: 環境変数 DATABASE_URL があれば Postgres（Neon など）、無ければ PGlite（--data のフォルダに保存）。
// 環境変数は .env（無ければ .dev.vars）から読み込む。ローカル確認では ALLOW_MOCK=true にするとモックログインが使える。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgDb, pgliteDb } from "../src/db.js";
import { createServer } from "../src/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

function loadEnv() {
  const env = { ...process.env };
  for (const f of [".env", ".dev.vars"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
  return env;
}

async function makeDb(env) {
  if (env.DATABASE_URL) {
    const pg = (await import("pg")).default;
    pg.types.setTypeParser(20, Number);
    pg.types.setTypeParser(1700, Number);
    console.log("DB: Postgres (DATABASE_URL)");
    return pgDb(new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 }));
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.resolve(root, arg("data", ".data/dev"));
  fs.mkdirSync(dir, { recursive: true });
  console.log(`DB: PGlite (${path.relative(root, dir)})`);
  return pgliteDb(new PGlite(dir));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, "public", path.normalize(p));
  if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

const env = loadEnv();
const server = createServer({ env, db: await makeDb(env) });
const port = Number(arg("port", env.PORT || 3000));

http
  .createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/ics/")) return serveStatic(req, res);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    try {
      const response = await server.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end("server error");
    }
    if (process.env.DEV_LOG) console.log(req.method, req.url, res.statusCode);
  })
  .listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
