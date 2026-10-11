// LINE 認証（ガラポン・チームアプリ共通）

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 同じトークンでの連続アクセスで毎回 LINE に問い合わせないよう、isolate 内で短時間キャッシュ
const cache = new Map();

// LIFF のアクセストークンを LINE Platform で検証し、プロフィールを取得する。
export async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "no_token", "LINEログインが必要です");

  if (token.startsWith("mock:")) {
    if (env.ALLOW_MOCK !== "true") throw new HttpError(401, "mock_disabled", "モックログインは無効です");
    const [, id, name] = token.split(":");
    return {
      userId: `mock-${id}`,
      displayName: decodeURIComponent(name || `テスト${id}`),
      pictureUrl: "",
    };
  }

  const cached = cache.get(token);
  if (cached && cached.exp > Date.now()) return cached.profile;

  const verify = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`,
  );
  if (!verify.ok) throw new HttpError(401, "invalid_token", "LINEの認証が切れました");
  const info = await verify.json();
  if (!env.LINE_CHANNEL_ID || String(info.client_id) !== String(env.LINE_CHANNEL_ID)) {
    throw new HttpError(401, "wrong_channel", "このアプリ用のトークンではありません");
  }
  if (!(info.expires_in > 0)) throw new HttpError(401, "expired", "LINEの認証が切れました");

  const prof = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!prof.ok) throw new HttpError(401, "profile_failed", "プロフィールを取得できませんでした");
  const p = await prof.json();
  const profile = { userId: p.userId, displayName: p.displayName, pictureUrl: p.pictureUrl || "" };
  if (cache.size > 500) cache.clear();
  cache.set(token, { profile, exp: Date.now() + Math.min(300, info.expires_in) * 1000 });
  return profile;
}

export function checkAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    throw new HttpError(403, "forbidden", "管理キーが違います");
  }
}
