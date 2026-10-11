// チーム共通のテーブル定義（Postgres）。複数の機能から参照されるテーブルはここで定義する。
// 機能固有のテーブルは各 features/*.js の migrations で定義すること。
// 既存マイグレーションは書き換えず、変更は新しい id のマイグレーションを追加する。
//
// 日付は "YYYY-MM-DD"、時刻は "HH:MM"（どちらも JST）、*_at は epoch ms（BIGINT）。
// 数値列は BIGINT で統一（db.js が JS の number に変換する）。真偽値は 0/1 の BIGINT。

export const coreMigrations = [
  {
    id: "core-001",
    sql: `
CREATE TABLE IF NOT EXISTS members (
  id BIGSERIAL PRIMARY KEY,
  line_user_id TEXT UNIQUE,              -- 助っ人など LINE 未連携のメンバーは NULL
  name TEXT NOT NULL,                    -- チーム内での表示名
  line_name TEXT,                        -- LINE の表示名
  picture TEXT,                          -- LINE のアイコンURL
  number TEXT,                           -- 背番号
  positions TEXT NOT NULL DEFAULT '',    -- 守備位置（カンマ区切り: 投,捕,一,二,三,遊,左,中,右）
  throws TEXT,                           -- 右 / 左
  bats TEXT,                             -- 右 / 左 / 両
  role TEXT NOT NULL DEFAULT 'member',   -- admin（監督・マネージャー） / member
  is_guest BIGINT NOT NULL DEFAULT 0,   -- 助っ人
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                    -- JSON
);

-- 通知などの二重送信防止（db.once で使用）
CREATE TABLE IF NOT EXISTS sent_log (
  key TEXT PRIMARY KEY,
  at BIGINT NOT NULL
);

-- 予定（試合・練習・その他）
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'game',     -- game / practice / other
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  meet_time TEXT,                        -- 集合時間
  start_time TEXT,                       -- 開始（プレイボール）
  end_time TEXT,
  venue TEXT,                            -- 球場
  venue_url TEXT,                        -- 地図URL
  meet_place TEXT,                       -- 集合場所
  opponent TEXT,
  belongings TEXT,                       -- 持ち物
  note TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled / canceled
  rsvp_deadline TEXT,                    -- 出欠締切日
  created_by BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);

-- 出欠
CREATE TABLE IF NOT EXISTS attendance (
  event_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  status TEXT NOT NULL,                  -- yes / no / maybe
  comment TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (event_id, member_id)
);

-- 試合結果
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT,                      -- 元になった予定（任意）
  season BIGINT NOT NULL,               -- 年度
  date TEXT NOT NULL,
  opponent TEXT NOT NULL,
  venue TEXT,
  kind TEXT NOT NULL DEFAULT 'friendly', -- league（公式戦） / tournament（大会） / friendly（練習試合）
  innings BIGINT NOT NULL DEFAULT 7,    -- 規定イニング
  bat_first BIGINT NOT NULL DEFAULT 1,  -- 1: 先攻 / 0: 後攻
  our_score BIGINT,
  their_score BIGINT,
  line_us TEXT,                          -- イニングごとの得点 JSON 配列 例 [0,2,1,null]
  line_them TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft（入力中） / final（確定）
  mvp_member_id BIGINT,
  memo TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_season ON games(season, date);

-- 打撃成績（1試合×1選手で1行）
CREATE TABLE IF NOT EXISTS batting (
  game_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  order_no BIGINT,                      -- 打順
  position TEXT,                         -- 守備位置
  pa BIGINT NOT NULL DEFAULT 0,         -- 打席
  ab BIGINT NOT NULL DEFAULT 0,         -- 打数
  h BIGINT NOT NULL DEFAULT 0,          -- 安打（二塁打・三塁打・本塁打を含む）
  d2 BIGINT NOT NULL DEFAULT 0,         -- 二塁打
  d3 BIGINT NOT NULL DEFAULT 0,         -- 三塁打
  hr BIGINT NOT NULL DEFAULT 0,         -- 本塁打
  rbi BIGINT NOT NULL DEFAULT 0,        -- 打点
  r BIGINT NOT NULL DEFAULT 0,          -- 得点
  so BIGINT NOT NULL DEFAULT 0,         -- 三振
  bb BIGINT NOT NULL DEFAULT 0,         -- 四球
  hbp BIGINT NOT NULL DEFAULT 0,        -- 死球
  sh BIGINT NOT NULL DEFAULT 0,         -- 犠打
  sf BIGINT NOT NULL DEFAULT 0,         -- 犠飛
  sb BIGINT NOT NULL DEFAULT 0,         -- 盗塁
  e BIGINT NOT NULL DEFAULT 0,          -- 失策
  updated_by BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (game_id, member_id)
);

-- 投手成績（1試合×1投手で1行）
CREATE TABLE IF NOT EXISTS pitching (
  game_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  order_no BIGINT,                      -- 登板順
  outs BIGINT NOT NULL DEFAULT 0,       -- 取ったアウト数（投球回 = outs / 3）
  bf BIGINT NOT NULL DEFAULT 0,         -- 対戦打者
  pitches BIGINT NOT NULL DEFAULT 0,    -- 投球数
  h BIGINT NOT NULL DEFAULT 0,          -- 被安打
  hr BIGINT NOT NULL DEFAULT 0,         -- 被本塁打
  so BIGINT NOT NULL DEFAULT 0,         -- 奪三振
  bb BIGINT NOT NULL DEFAULT 0,         -- 与四球
  hbp BIGINT NOT NULL DEFAULT 0,        -- 与死球
  r BIGINT NOT NULL DEFAULT 0,          -- 失点
  er BIGINT NOT NULL DEFAULT 0,         -- 自責点
  decision TEXT,                         -- W（勝） / L（敗） / S（セーブ） / H（ホールド） / NULL
  updated_by BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (game_id, member_id)
);
`,
  },
];

export const DEFAULT_SETTINGS = {
  teamName: "マイチーム",
  season: null, // null のときは今年
  inningsPerGame: 7, // 防御率などの計算に使う規定イニング（草野球は7回が多い）
  homeVenue: "",
  icsToken: null, // カレンダー購読URL用のトークン（初回に自動生成）
};
