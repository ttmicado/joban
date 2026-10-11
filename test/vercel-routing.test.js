// vercel.json の rewrite が意図どおり（静的ファイルは public/、API と ics は api/handler.js）か確認する
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getTransformedRoutes } from "@vercel/routing-utils";

const cfg = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const { routes, error } = getTransformedRoutes(cfg);

// filesystem の後の rewrite を順に当てはめる（Vercel と同じく最初に一致したもの）
function resolve(path) {
  const after = routes.slice(routes.findIndex((r) => r.handle === "filesystem") + 1);
  for (const r of after) {
    const m = new RegExp(r.src).exec(path);
    if (m) return r.dest.replace(/\$(\d)/g, (_, i) => m[i] ?? "");
  }
  return null;
}

test("vercel.json の rewrite", () => {
  assert.equal(error, null);
  assert.equal(routes[0].handle, "filesystem");
  assert.match(resolve("/api/team/events"), /^\/api\/handler\?__path=%2Fapi%2Fteam\/events/);
  assert.match(resolve("/api/garapon/board"), /__path=%2Fapi%2Fgarapon\/board/);
  assert.match(resolve("/api/cron"), /__path=%2Fapi%2Fcron/);
  assert.match(resolve("/api/line/webhook"), /__path=%2Fapi%2Fline\/webhook/);
  assert.match(resolve("/ics/abc123.ics"), /__path=%2Fics%2Fabc123\.ics/);
  assert.equal(resolve("/api/handler"), null); // 関数自身は書き換えない
  assert.equal(resolve("/app/main.js"), null);
  assert.ok(cfg.crons.some((c) => c.path === "/api/cron"));
  assert.equal(cfg.outputDirectory, "public");
});
