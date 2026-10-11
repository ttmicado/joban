// 機能モジュールの一覧。順番はイベント購読・cron の実行順にもなる。
import members from "./members.js";
import schedule from "./schedule.js";
import games from "./games.js";
import stats from "./stats.js";
import community from "./community.js";
import line from "./line.js";
import importer from "./importer.js";
import lives from "./lives.js";

export const features = [members, schedule, games, stats, community, line, importer, lives];
