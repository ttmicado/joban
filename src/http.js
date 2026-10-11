import { HttpError } from "./auth.js";

// リクエストの JSON 本文を読む。本文が空（DELETE や本文なしの POST）なら null。
// 不正な JSON は 400。
export async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "リクエストの形式が不正です");
  }
}
