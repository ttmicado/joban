// LINE Messaging API の最小クライアント。トークンは env からのみ読み、ログやレスポンスに出さない。
const API = "https://api.line.me/v2/bot";

export const hasToken = (env) => !!env?.LINE_MESSAGING_TOKEN;

async function call(env, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

// LINE のエラー応答を短い説明に（トークン等は含まれない）
export function describeError(r) {
  if (!r) return "unknown";
  const msg = r.data?.message ? `: ${String(r.data.message).slice(0, 120)}` : "";
  return `HTTP ${r.status}${msg}`;
}

export async function push(env, to, messages) {
  if (!hasToken(env) || !to) return { ok: false, status: 0, skipped: true };
  return call(env, "POST", "/message/push", { to, messages: messages.slice(0, 5) });
}

export async function reply(env, replyToken, messages) {
  if (!hasToken(env) || !replyToken) return { ok: false, status: 0, skipped: true };
  return call(env, "POST", "/message/reply", { replyToken, messages: messages.slice(0, 5) });
}

export async function groupSummary(env, groupId) {
  if (!hasToken(env) || !groupId) return null;
  const r = await call(env, "GET", `/group/${encodeURIComponent(groupId)}/summary`);
  return r.ok ? r.data : null;
}
