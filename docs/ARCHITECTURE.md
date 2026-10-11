# チーム運営アプリ 設計メモ（開発者・エージェント向け）

草野球チームの運営（日程・出欠・試合結果・個人成績・ランキング・起床報告・練習報告・連絡）を
LINE ミニアプリ（LIFF）で完結させる。ガラポン抽選会（`/garapon/`）も同じアプリに同居している。

## 全体構成

```
public/                     静的ファイル（ビルド不要の ES Modules）
  index.html                チームアプリのシェル（ヘッダー・タブバー）
  app/core.js               ログイン・API・ルーター・html テンプレート
  app/ui.js                 共通 UI（シート・トースト・フォーム・ステッパー・日付など）
  app/styles.css            共通デザイン（トークンと部品）
  app/main.js               起動・ホーム・参加・メンバー・設定・その他メニュー
  app/lib/stats.js          打率・防御率などの計算（サーバーからも import）
  app/features/<name>.js    機能ごとの画面
  app/features/<name>.css   機能ごとのスタイル（index.html で読み込み済み）
  garapon/                  ガラポン抽選会（独立したページ）
src/
  worker.js                 Cloudflare Worker（/api/team/* → Team DO、/api/garapon/*、/ics/*、/api/line/webhook、cron）
  auth.js                   LINE アクセストークン検証
  team/app.js               ルーティング・認可・マイグレーション・イベント配信・cron
  team/db.js                SQLite ラッパー（DO と node:sqlite 共通）
  team/schema.js            共通テーブル定義
  team/validate.js          入力検証ヘルパー
  team/time.js              JST の日付・時刻ヘルパー
  team/features/<name>.js   機能ごとの API
test/
  helpers/team.js           node:sqlite のメモリ DB でチームアプリを動かすテストヘルパー
  <name>.test.js            機能ごとのテスト
```

データはすべて Durable Object `Team`（SQLite）1つに入る。リクエストは直列処理なので競合を気にしなくてよい。

## 機能の担当範囲

| 機能 | サーバー | 画面ルート | API パス |
| --- | --- | --- | --- |
| members（コア） | features/members.js | `/` `/join` `/more` `/me/edit` `/members` `/settings` | `/me` `/join` `/members` `/settings` |
| schedule 日程 | features/schedule.js | `/schedule…` `/polls…` `/calendar` | `/events…` `/polls…` `/venues…` `/ics/:token` |
| games 試合 | features/games.js | `/games…` | `/games…` |
| stats 成績 | features/stats.js | `/stats…` `/players/:id` | `/stats…` |
| community チーム | features/community.js | `/team` `/notices…` `/wakeup…` `/practice…` | `/notices…` `/wakeups…` `/practices…` |
| line 通知 | features/line.js | `/line…` | `/line…` |

自分の担当外のファイル（特に core.js / ui.js / styles.css / main.js / app.js / schema.js）は変更しない。
コアに必要な変更があれば、担当外ファイルを直さずに報告する。

## サーバー側の機能モジュール

```js
// src/team/features/schedule.js
import { badRequest, notFound } from "../errors.js";
import { v } from "../validate.js";

export default {
  name: "schedule",
  migrations: [{ id: "schedule-001", sql: `CREATE TABLE IF NOT EXISTS polls (...);` }],
  routes: [
    ["GET", "/events", (c) => ({ events: c.db.all("SELECT * FROM events WHERE date >= ?", c.now.date) })],
    ["POST", "/events", createEvent, { auth: "admin" }],
    ["GET", "/ics/:token", ics, { auth: "public" }],
  ],
  on: { "game.finalized": async (c, { game }) => {} },
  cron: async (c) => {},
};
```

- `auth`: `public`（ログイン不要）/ `user`（LINE ログインのみ）/ `member`（既定。チーム参加済み）/ `admin`
- handler の引数 `c`: `db` `env` `now`（JST `{ts,date,time,year,weekday}`）`params` `query` `body` `rawBody` `headers`
  `user` `member`（members テーブルの行）`isAdmin` `settings` `saveSettings(patch)` `emit(name, payload)`
  `once(key, fn)`（二重実行防止）`requireAdminOrSelf(memberId)`
- 戻り値はそのまま JSON になる。JSON 以外は `import { raw } from "../app.js"` の `raw(body, { headers })`
- エラーは `throw badRequest("メッセージ")` など（`errors.js`）。メッセージは利用者向けの日本語で
- DB: `c.db.all(sql, ...params)` `c.db.one(...)` `c.db.run(...)` → `{changes, lastId}` `c.db.tx(fn)`
- メンバーを返すときは `publicMember(row)`（`features/members.js`）を使い、LINE の userId は外に出さない
- マイグレーション id は `<機能名>-001` から。適用済みのものは書き換えず、追加で変更する
- 日付は `"YYYY-MM-DD"`、時刻は `"HH:MM"`（JST の文字列）。`*_at` は epoch ms

### 機能間のイベント（emit / on）

通知（line 機能）などが購読する。payload の形は守ること。

| 名前 | 発行元 | payload |
| --- | --- | --- |
| `member.joined` | members | `{ member }`（publicMember） |
| `event.created` | schedule | `{ event }`（events テーブルの行） |
| `event.updated` | schedule | `{ event, before }` |
| `event.canceled` | schedule | `{ event }` |
| `poll.created` | schedule | `{ poll, options }` |
| `poll.decided` | schedule | `{ poll, event }` |
| `game.finalized` | games | `{ game }`（games テーブルの行。status が final になったとき） |
| `notice.created` | community | `{ notice, author }` |
| `wakeup.created` | community | `{ wakeup, member, event }` |
| `practice.created` | community | `{ practice, member }` |

### 共通テーブル（src/team/schema.js）

`members` `settings` `sent_log` `events` `attendance` `games` `batting` `pitching`。
列の意味は schema.js のコメント参照。機能固有のテーブル名は機能名で始めるか、下表のとおりにする。

| テーブル | 担当 | 備考 |
| --- | --- | --- |
| `polls` `poll_options` `poll_answers` `venues` | schedule | 日程調整・球場マスタ |
| `notices` `notice_reads` `wakeups` `practices` `practice_likes` | community | `wakeups(event_id, member_id, at, comment)` は line 機能も参照する |
| `line_*` | line | |

## 画面側の機能モジュール

```js
// public/app/features/schedule.js
import { get, html, mount, on, post, setHeader, state, isAdmin, navigate } from "../core.js";
import { sheet, toast, busy, fmtDate, relDay, empty } from "../ui.js";

export default {
  name: "schedule",
  routes: {
    "/schedule": async (view, { params, query }) => {
      setHeader({ title: "日程", actions: html`<button class="btn btn-sm">…</button>` });
      const { events } = await get("/events");
      mount(view, html`<div class="list">…</div>`);
      const off = on(view, "click", "[data-act=rsvp]", (e, el) => {});
      return () => off(); // ページ離脱時の後片付け（任意）
    },
  },
  homeCards: [{ order: 10, render: async () => html`<div class="card">…</div>`, bind: (el) => {} }],
  menu: [{ path: "/polls", label: "日程調整", icon: "🗳", order: 10 }],
};
```

- テンプレートは `` html`...` ``（自動エスケープ）。生 HTML は `raw()`。配列はそのまま埋め込める
- ルートは hash（`#/schedule/12?tab=x`）。遷移は `<a href="#/...">` か `navigate(path)`
- `setHeader({ title, back: "/schedule", actions })` でヘッダー設定
- 入力は `sheet()` のボトムシート + `readForm(form)` + `busy(btn, async () => …)` が基本
- 成績入力などの数値は `stepper(name, label, value)` + `bindSteppers(root)`
- 管理者だけの操作は `isAdmin()` で出し分ける（サーバー側でも必ずチェック）
- LINE へのシェアは `shareToLine([flexMessage])`（core.js）。アプリ内リンクは `appUrl("/schedule/12")`
- 共通クラス: `card` `card-hero` `card-head` `card-title` `list` `list-item` `list-main` `list-title` `list-sub`
  `btn` `btn-primary` `btn-amber` `btn-ghost` `btn-sm` `btn-block` `chip chip-green|amber|red|blue|purple`
  `form` `field` `input` `select` `textarea` `pills pill` `segmented` `tiles tile tile-label tile-value`
  `table-wrap table` `scoreboard` `result result-win|lose|draw` `datebox` `empty` `fab` `section-title`
  `avatar avatar-xs|sm|md|lg|xl` `uni`（背番号）`num`（数字フォント）`muted` `row gap` `grid-2` `stack`
- デザイン: ナイターの球場（濃紺の背景・芝の緑・スコアボードの黄色）。スマホ縦持ち・親指操作が前提。
  ボタンは 44px 以上、主要操作は画面下部に。ワクワク感（数字のカウントアップ、勝利時の演出など）を大切に

## 開発・テスト

```bash
npm test                                  # 全テスト（node:sqlite で API を直接テスト）
npx wrangler dev --port 8787 --persist-to .wrangler/state   # ローカル起動（.dev.vars に ALLOW_MOCK=true）
# ブラウザで http://127.0.0.1:8787/?mock=taro&name=太郎  （mock の値ごとに別ユーザー。最初の人が管理者）
```

テストは `test/helpers/team.js` の `makeTeam()` を使う:

```js
const t = makeTeam({ now: "2026-10-18T06:00" });
const admin = await t.join("監督");        // 最初の参加者は管理者
const taro = await t.join("太郎");
const res = await admin.post("/events", { title: "練習試合", date: "2026-10-25" });
assert.equal(res.status, 200);
t.setNow("2026-10-25T05:30"); await t.cron();
```
