// 日付・時刻はすべて日本時間（JST）の文字列で扱う。
//   日付: "YYYY-MM-DD"  時刻: "HH:MM"
const JST = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

export function jst(ts = Date.now()) {
  const d = new Date(ts + JST);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { ts, date, time, year: d.getUTCFullYear(), weekday: d.getUTCDay() };
}

// "YYYY-MM-DD" に n 日足した日付
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// JST の日付+時刻 → epoch ms
export function toTs(date, time = "00:00") {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - JST;
}

// 実在する日付だけ true（"2026-02-30" や "2026-13-01" は false）
export const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 1900 || y > 2999) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
export const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
