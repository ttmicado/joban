// LINE Messaging API の webhook 署名検証
// x-line-signature = base64(HMAC-SHA256(channelSecret, rawBody))

const enc = new TextEncoder();

function b64ToBytes(s) {
  try {
    const bin = atob(String(s).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToB64(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function hmacSha256(secret, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

// 長さが同じなら内容に関係なく同じ時間で比較する
export function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifySignature(secret, rawBody, signature) {
  if (!secret || typeof rawBody !== "string" || !signature) return false;
  const given = b64ToBytes(signature);
  if (!given || given.length !== 32) return false;
  const expected = await hmacSha256(secret, rawBody);
  return timingSafeEqual(expected, given);
}
