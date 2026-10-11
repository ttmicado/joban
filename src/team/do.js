import { DurableObject } from "cloudflare:workers";
import { createTeamApp } from "./app.js";
import { durableDb } from "./db.js";
import { features } from "./features/index.js";

// チームのデータはこの Durable Object 1つ（SQLite）に集約する。
// リクエストは直列に処理されるため、同時更新の競合を気にしなくてよい。
export class Team extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = createTeamApp({ db: durableDb(ctx.storage), env, features });
  }

  handle(req) {
    return this.app.handle(req);
  }

  cron() {
    return this.app.cron();
  }
}
