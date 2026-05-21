import type { Env } from "../types";

const COOKIE_NAME = "bedrock_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(normalized);
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return cookieHeader("", 0, true);
}

export async function createSessionCookie(env: Env, request: Request): Promise<string> {
  if (!env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is not configured");
  const payload = base64UrlEncode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  }));
  const signature = await hmac(env.ADMIN_PASSWORD, payload);
  return cookieHeader(`${payload}.${signature}`, SESSION_TTL_SECONDS, new URL(request.url).protocol === "https:");
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (await hmac(env.ADMIN_PASSWORD, payload) !== signature) return false;

  try {
    const body = JSON.parse(base64UrlDecode(payload)) as { exp?: number };
    return typeof body.exp === "number" && body.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export function passwordConfigured(env: Env): boolean {
  return !!env.ADMIN_PASSWORD;
}
