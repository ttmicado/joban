// LINE Flex Message ビルダー（フロントの shareToLine とサーバーの通知の両方から import する純粋関数）
//
//   import { flexMessage, eventBubble } from "../lib/flex.js";
//   await shareToLine([flexMessage("10/18 練習試合", eventBubble(event, { url: appUrl(`/schedule/${event.id}`) }))]);
//
// - DOM や fetch には依存しない（サーバーの src/team/features/line.js からも import する）
// - LINE は空文字の text を受け付けないので、値が無い行は自動で省く
// - ボタンの URL は https のみ（無ければボタンを出さない）

export const COLORS = {
  night: "#0a1124",
  navy: "#141f3c",
  navy2: "#1d3263",
  green: "#27d17f",
  greenDark: "#128a52",
  amber: "#ffc83d",
  red: "#ff5a5f",
  blue: "#4da3ff",
  purple: "#a78bfa",
  text: "#1b2440",
  sub: "#5f6f96",
  faint: "#93a3c8",
  line: "#e3e8f4",
  board: "#08100a",
};

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

// "2026-10-18" → "10/18(日)"
export function fmtDay(date, { year = false } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || "";
  const [y, m, d] = date.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${year ? `${y}/` : ""}${m}/${d}(${w})`;
}

const TYPE_LABEL = { game: "試合", practice: "練習", other: "予定" };
export const eventTypeLabel = (t) => TYPE_LABEL[t] || "予定";

// 文字列を LINE の制限内に収める
export const clip = (s, n) => {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const has = (v) => v !== null && v !== undefined && String(v).trim() !== "";

// ---------------------------------------------------------------- 部品
export function text(t, opts = {}) {
  return { type: "text", text: clip(has(t) ? t : " ", 2000), wrap: true, ...opts };
}

export function box(layout, contents, opts = {}) {
  return { type: "box", layout, contents: contents.filter(Boolean), ...opts };
}

export function button(label, url, { style = "primary", color = COLORS.green } = {}) {
  if (!isUrl(url)) return null;
  return {
    type: "button",
    style,
    height: "sm",
    ...(style === "primary" ? { color } : {}),
    action: { type: "uri", label: clip(label, 40), uri: url },
  };
}

const isUrl = (u) => typeof u === "string" && /^https:\/\/\S+$/.test(u) && u.length <= 1000;

// 「ラベル  値」の1行（値が空なら null）
export function infoRow(label, value, { color = COLORS.text, bold = false } = {}) {
  if (!has(value)) return null;
  return box(
    "baseline",
    [
      text(label, { size: "sm", color: COLORS.faint, flex: 2, wrap: false }),
      text(String(value), { size: "sm", color, flex: 6, weight: bold ? "bold" : "regular" }),
    ],
    { spacing: "md" },
  );
}

// 濃紺のヘッダー（小さなラベル＋大きなタイトル）
function header(label, title, { accent = COLORS.green, sub } = {}) {
  return box(
    "vertical",
    [
      has(label) ? text(label, { size: "xs", color: accent, weight: "bold" }) : null,
      text(clip(title, 80), { size: "xl", color: "#ffffff", weight: "bold", margin: "sm" }),
      has(sub) ? text(sub, { size: "sm", color: COLORS.faint, margin: "sm" }) : null,
    ],
    { backgroundColor: COLORS.night, paddingAll: "18px", paddingBottom: "16px" },
  );
}

function footer(buttons) {
  const list = buttons.filter(Boolean);
  if (!list.length) return undefined;
  return box("vertical", list, { spacing: "sm", paddingAll: "12px" });
}

function bubble({ header: h, body, footer: f, size = "mega" }) {
  const out = { type: "bubble", size, header: h, body };
  if (f) out.footer = f;
  out.styles = { footer: { separator: true, separatorColor: COLORS.line } };
  return out;
}

// メッセージ本体。altText は通知やトーク一覧に出る文言
export function flexMessage(altText, contents) {
  return { type: "flex", altText: clip(has(altText) ? altText : "お知らせ", 400), contents };
}

// 名前の一覧（多いときは「ほか○人」）
export function names(list, { max = 20, empty = "なし" } = {}) {
  if (!list?.length) return empty;
  const shown = list.slice(0, max).join("、");
  return list.length > max ? `${shown} ほか${list.length - max}人` : shown;
}

// ---------------------------------------------------------------- 予定
// event: events テーブルの行（または同じ形のオブジェクト）
// opts: { label, url, buttonLabel, attendance: { yes, maybe, no, unanswered: [名前] }, changes: [[項目, 前, 後]], note, accent, canceled }
export function eventBubble(event, opts = {}) {
  const e = event || {};
  const canceled = opts.canceled ?? e.status === "canceled";
  const accent = canceled ? COLORS.red : opts.accent || COLORS.green;
  const label = opts.label || `${eventTypeLabel(e.type)}のお知らせ`;
  const withOpponent = has(e.opponent) && !String(e.title || "").includes(e.opponent);
  const title = withOpponent ? `${e.title || eventTypeLabel(e.type)} vs ${e.opponent}` : e.title;
  const when = [fmtDay(e.date), e.start_time ? `${e.start_time} 開始` : ""].filter(Boolean).join(" ");

  const rows = [
    infoRow("日付", fmtDay(e.date), { bold: true }),
    infoRow("集合", [e.meet_time, e.meet_place].filter(has).join(" ") || null, { color: COLORS.greenDark, bold: true }),
    infoRow("開始", e.start_time),
    infoRow("球場", e.venue),
    infoRow("持ち物", e.belongings),
    infoRow("締切", e.rsvp_deadline ? `${fmtDay(e.rsvp_deadline)} まで` : null),
  ];

  const body = [box("vertical", rows, { spacing: "sm" })];

  if (opts.changes?.length) {
    body.unshift(
      box(
        "vertical",
        [
          text("変更点", { size: "xs", color: COLORS.red, weight: "bold" }),
          ...opts.changes.map(([k, before, after]) =>
            box(
              "baseline",
              [
                text(k, { size: "sm", color: COLORS.faint, flex: 2, wrap: false }),
                text(`${has(before) ? before : "未定"} → ${has(after) ? after : "未定"}`, { size: "sm", color: COLORS.text, weight: "bold", flex: 6 }),
              ],
              { spacing: "md" },
            ),
          ),
        ],
        { spacing: "sm", paddingAll: "12px", backgroundColor: "#fff1f1", cornerRadius: "10px", margin: "none" },
      ),
    );
  }

  if (opts.attendance) {
    const a = opts.attendance;
    body.push({ type: "separator", margin: "lg", color: COLORS.line });
    body.push(
      box(
        "horizontal",
        [
          countCell("出席", a.yes ?? 0, COLORS.greenDark),
          countCell("未定", a.maybe ?? 0, "#b8860b"),
          countCell("欠席", a.no ?? 0, COLORS.red),
          countCell("未回答", a.unanswered?.length ?? a.unansweredCount ?? 0, COLORS.sub),
        ],
        { margin: "lg" },
      ),
    );
    if (a.unanswered?.length) {
      body.push(text(`未回答: ${names(a.unanswered)}`, { size: "xs", color: COLORS.sub, margin: "md" }));
    }
  }

  if (has(opts.note)) body.push(text(opts.note, { size: "sm", color: COLORS.text, margin: "lg" }));
  if (canceled) body.unshift(text("この予定は中止になりました", { size: "md", weight: "bold", color: COLORS.red }));

  return bubble({
    header: header(label, title || "予定", { accent, sub: when }),
    body: box("vertical", body, { spacing: "md", paddingAll: "18px" }),
    footer: footer([button(opts.buttonLabel || "アプリで開く", opts.url, { color: canceled ? COLORS.sub : COLORS.green })]),
  });
}

function countCell(label, n, color) {
  return box(
    "vertical",
    [
      text(String(n), { size: "xxl", weight: "bold", color, align: "center" }),
      text(label, { size: "xxs", color: COLORS.sub, align: "center" }),
    ],
    { flex: 1 },
  );
}

// ---------------------------------------------------------------- 試合結果（スコアボード風）
// game: games テーブルの行（line_us / line_them は JSON 文字列か配列）
// opts: { teamName, url, mvp: "名前", highlights: ["太郎 3安打", ...] }
export function resultBubble(game, opts = {}) {
  const g = game || {};
  const us = Number(g.our_score ?? 0);
  const them = Number(g.their_score ?? 0);
  const res = us > them ? ["勝利", COLORS.green, "WIN"] : us < them ? ["敗戦", COLORS.red, "LOSE"] : ["引き分け", COLORS.faint, "DRAW"];
  const teamName = opts.teamName || "自チーム";
  const lineUs = parseLine(g.line_us);
  const lineThem = parseLine(g.line_them);
  const innings = Math.max(Number(g.innings) || 0, lineUs.length, lineThem.length, 1);
  const showLine = (lineUs.length || lineThem.length) && innings <= 12;
  const first = Number(g.bat_first ?? 1) === 1;
  const teams = first
    ? [[teamName, lineUs, us], [g.opponent || "相手", lineThem, them]]
    : [[g.opponent || "相手", lineThem, them], [teamName, lineUs, us]];

  const cell = (t, { color = COLORS.amber, flex = 2, size = "sm", weight = "bold" } = {}) =>
    text(t, { size, color, align: "center", flex, weight, wrap: false });

  const board = [];
  if (showLine) {
    board.push(
      box("horizontal", [
        text(" ", { size: "xxs", flex: 7, wrap: false }),
        ...Array.from({ length: innings }, (_, i) => cell(String(i + 1), { color: "#c9d6c9", size: "xxs", weight: "regular" })),
        cell("R", { color: "#ffffff", size: "xxs", flex: 3 }),
      ]),
    );
  }
  for (const [name, line, total] of teams) {
    board.push(
      box(
        "horizontal",
        [
          text(clip(name, 10), { size: "sm", color: "#ffffff", weight: "bold", flex: 7, wrap: false }),
          ...(showLine
            ? Array.from({ length: innings }, (_, i) => cell(line[i] === null || line[i] === undefined ? "-" : String(line[i])))
            : []),
          cell(String(total), { color: "#ffffff", flex: 3, size: showLine ? "md" : "xl" }),
        ],
        { margin: "sm" },
      ),
    );
  }

  const body = [
    box(
      "horizontal",
      [
        text(String(us), { size: "5xl", weight: "bold", color: res[1], align: "end", flex: 3 }),
        text("-", { size: "3xl", color: COLORS.faint, align: "center", flex: 1, gravity: "center" }),
        text(String(them), { size: "5xl", weight: "bold", color: COLORS.text, align: "start", flex: 3 }),
      ],
      { alignItems: "center" },
    ),
    text(`${res[0]}！ vs ${g.opponent || "相手"}`, { size: "md", weight: "bold", align: "center", color: res[1] === COLORS.faint ? COLORS.sub : res[1] }),
    box("vertical", board, { backgroundColor: COLORS.board, paddingAll: "10px", cornerRadius: "8px", margin: "lg" }),
    box("vertical", [infoRow("球場", g.venue), infoRow("MVP", opts.mvp, { color: "#b8860b", bold: true })], { spacing: "sm", margin: "lg" }),
  ];
  if (opts.highlights?.length) {
    body.push(text(opts.highlights.map((h) => `・${h}`).join("\n"), { size: "sm", color: COLORS.text, margin: "md" }));
  }

  return bubble({
    header: header(`試合結果 ${res[2]}`, `${fmtDay(g.date)} ${teamName}`, { accent: res[1] === COLORS.faint ? COLORS.amber : res[1] }),
    body: box("vertical", body, { spacing: "sm", paddingAll: "18px" }),
    footer: footer([button(opts.buttonLabel || "試合の詳細を見る", opts.url)]),
  });
}

function parseLine(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------- 汎用
// opts: { label, title, body, rows: [[ラベル, 値]], url, buttonLabel, accent, sub }
export function simpleBubble(opts = {}) {
  const contents = [];
  if (has(opts.body)) contents.push(text(clip(opts.body, 1000), { size: "sm", color: COLORS.text }));
  if (opts.rows?.length) contents.push(box("vertical", opts.rows.map(([k, val]) => infoRow(k, val)), { spacing: "sm", margin: "md" }));
  if (!contents.length) contents.push(text(" ", { size: "xs" }));
  return bubble({
    header: header(opts.label, opts.title || "お知らせ", { accent: opts.accent, sub: opts.sub }),
    body: box("vertical", contents, { spacing: "md", paddingAll: "18px" }),
    footer: footer([button(opts.buttonLabel || "アプリで開く", opts.url)]),
  });
}

// 見出し付きの名前リストなど（リマインド・出欠状況・ランキング）
// sections: [{ heading, color, lines: ["…"] | rows: [[左, 右]] }]
export function listBubble(opts = {}) {
  const contents = [];
  if (has(opts.body)) contents.push(text(opts.body, { size: "sm", color: COLORS.text }));
  (opts.sections || []).forEach((s, i) => {
    // 区切り線を入れる前に「前に何かあるか」を判定する（入れた後だと常に真になる）
    const hasBefore = i > 0 || contents.length > 0;
    if (hasBefore) contents.push({ type: "separator", margin: "lg", color: COLORS.line });
    const inner = [text(s.heading, { size: "sm", weight: "bold", color: s.color || COLORS.text })];
    if (s.rows?.length) {
      s.rows.forEach(([l, r], j) =>
        inner.push(
          box(
            "baseline",
            [
              text(`${j + 1}`, { size: "sm", color: j === 0 ? "#b8860b" : COLORS.faint, flex: 1, weight: "bold", wrap: false }),
              text(l, { size: "sm", color: COLORS.text, flex: 6, wrap: false }),
              text(r, { size: "sm", color: COLORS.text, flex: 3, align: "end", weight: "bold", wrap: false }),
            ],
            { spacing: "sm" },
          ),
        ),
      );
    } else if (s.lines?.length) {
      inner.push(text(s.lines.join("\n"), { size: "sm", color: COLORS.sub }));
    } else {
      inner.push(text(s.empty || "なし", { size: "sm", color: COLORS.faint }));
    }
    contents.push(box("vertical", inner, { spacing: "sm", margin: hasBefore ? "lg" : "none" }));
  });
  if (!contents.length) contents.push(text(" ", { size: "xs" }));
  return bubble({
    header: header(opts.label, opts.title || "お知らせ", { accent: opts.accent, sub: opts.sub }),
    body: box("vertical", contents, { paddingAll: "18px" }),
    footer: footer([button(opts.buttonLabel || "アプリで開く", opts.url)]),
  });
}

// 複数のバブルを横スクロールで
export const carousel = (bubbles) => ({ type: "carousel", contents: bubbles.slice(0, 12) });
