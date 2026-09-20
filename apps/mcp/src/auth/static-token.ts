const TOKEN_AUDIENCE = "mineral-static";
const MAX_TTL_SECONDS = 60 * 60;

type StaticTokenPayload = {
  aud: typeof TOKEN_AUDIENCE;
  exp: number;
  iat: number;
  prefix: string;
};

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(normalized);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export function normalizeStaticPrefix(prefix?: string): string | null {
  const normalized = (prefix ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.includes("//")) return null;
  if (normalized.startsWith(".history/") || normalized.startsWith(".trash/")) return null;
  return normalized && !normalized.endsWith("/") ? `${normalized}/` : normalized;
}

export function isProtectedSystemKey(key: string): boolean {
  return key.startsWith(".history/") || key.startsWith(".trash/");
}

export async function createStaticAccessToken(
  secret: string,
  prefix: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<{ token: string; expiresAt: number }> {
  if (!secret) throw new Error("STATIC_ACCESS_SECRET is not configured");
  if (ttlSeconds < 30 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`expiresIn must be between 30 and ${MAX_TTL_SECONDS} seconds`);
  }
  const payload: StaticTokenPayload = {
    aud: TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    prefix,
  };
  const encodedPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    new TextEncoder().encode(encodedPayload)
  );
  return {
    token: `${encodedPayload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`,
    expiresAt: payload.exp,
  };
}

export async function verifyStaticAccessToken(
  token: string,
  secret: string,
  key: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!token || !secret || isProtectedSystemKey(key)) return false;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return false;
  const payloadBytes = base64UrlDecodeBytes(encodedPayload);
  const signature = base64UrlDecodeBytes(encodedSignature);
  if (!payloadBytes || !signature) return false;

  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await importHmacKey(secret),
    signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength
    ) as ArrayBuffer,
    new TextEncoder().encode(encodedPayload)
  );
  if (!validSignature) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<StaticTokenPayload>;
    return payload.aud === TOKEN_AUDIENCE
      && typeof payload.iat === "number"
      && payload.iat <= nowSeconds + 30
      && typeof payload.exp === "number"
      && payload.exp > nowSeconds
      && payload.exp - payload.iat <= MAX_TTL_SECONDS
      && typeof payload.prefix === "string"
      && key.startsWith(payload.prefix);
  } catch {
    return false;
  }
}

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}
