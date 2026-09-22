import { isRemoteChangeChannel } from "./channel.js";

export { deriveRemoteChangeChannel, canonicalChannelInput, canonicalEndpoint, canonicalPrefix, type CanonicalRemoteIdentity } from "./channel.js";
export { isRemoteChangeChannel };
export { parseSubscribeMessage, SUBSCRIBE_MESSAGE_TYPES, type SubscribeMessage, type SubscribeMessageType, type CurrentGenerationMessage, type RemoteDirtyMessage } from "./gateway-subscribe.js";

/** The only protocol revision this repository speaks on the wire. */
export const SYNC_GATEWAY_PROTOCOL_VERSION = 1;

export type GatewayGenerationSnapshot = { generation: string };
export type GatewayDirtyResult = { generation: string };

/** A short-lived, channel-scoped credential for transports that cannot send headers. */
export type GatewayWebSocketTicket = {
  protocol: number;
  ticket: string;
  expiresAt: number;
};

const encoder = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  if (!BASE64URL.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { return undefined; }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The digest is always exactly 32 bytes, so its unpadded base64url form is always 43 characters.
 * That length is what the Gateway's channel pattern requires. Re-exported from `channel.ts`; it is
 * listed here as well because every Gateway client needs both the protocol constants and this.
 */

export function isGatewayGenerationSnapshot(value: unknown): value is GatewayGenerationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const generation = (value as { generation?: unknown }).generation;
  return typeof generation === "string" && /^\d+$/.test(generation);
}

export function isGatewayDirtyResult(value: unknown): value is GatewayDirtyResult {
  return isGatewayGenerationSnapshot(value);
}

export function isGatewayWebSocketTicket(value: unknown): value is GatewayWebSocketTicket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { protocol?: unknown; ticket?: unknown; expiresAt?: unknown };
  return candidate.protocol === SYNC_GATEWAY_PROTOCOL_VERSION && typeof candidate.ticket === "string" && candidate.ticket.length > 0 && typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt);
}

function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Signed, stateless WebSocket ticket.
 *
 * Browsers and Obsidian WebViews cannot attach an `Authorization` header to `new WebSocket(...)`,
 * so a long-lived bearer token must never be placed in a URL. This ticket is the bridge: it is
 * scoped to one channel, expires quickly, and is signed with the Gateway's existing secret, so no
 * KV, D1, Queue, or ticket database is required. It carries no R2 credential and no file data.
 */
export async function createGatewayWebSocketTicket(input: { channel: string; secret: string; ttlMs: number; now: number }): Promise<GatewayWebSocketTicket> {
  if (!isRemoteChangeChannel(input.channel)) throw new TypeError("a WebSocket ticket requires a canonical channel");
  if (!input.secret) throw new TypeError("a WebSocket ticket requires a signing secret");
  const expiresAt = input.now + Math.max(1, Math.floor(input.ttlMs));
  const payload = [`v${SYNC_GATEWAY_PROTOCOL_VERSION}`, input.channel, String(expiresAt)].join(".");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(input.secret), encoder.encode(payload));
  return { protocol: SYNC_GATEWAY_PROTOCOL_VERSION, ticket: `${payload}.${toBase64Url(new Uint8Array(signature))}`, expiresAt };
}

export async function verifyGatewayWebSocketTicket(input: { ticket: string | undefined; channel: string; secret: string; now: number }): Promise<boolean> {
  if (!input.ticket || !input.secret) return false;
  const parts = input.ticket.split(".");
  if (parts.length !== 4) return false;
  const [version, ticketChannel, expiresAt, signature] = parts;
  if (version !== `v${SYNC_GATEWAY_PROTOCOL_VERSION}`) return false;
  if (ticketChannel !== input.channel) return false;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= input.now) return false;
  const decoded = fromBase64Url(signature);
  if (!decoded) return false;
  // A fresh copy guarantees a plain ArrayBuffer; the key is HMAC, so `verify` recomputes the tag
  // internally and compares the full value in constant time.
  const provided = new Uint8Array(decoded.byteLength);
  provided.set(decoded);
  try {
    return await crypto.subtle.verify("HMAC", await signingKey(input.secret), provided, encoder.encode([version, ticketChannel, expiresAt].join(".")));
  } catch { return false; }
}

/** Never log a ticket or a token: this is the only representation allowed in diagnostics. */
export function safeTicketFingerprint(ticket: string): string {
  return `${ticket.length}:${ticket.slice(0, 4)}`;
}

/** Generations are compared as decimal strings; this bound keeps a hostile value from being parsed. */
export const MAX_GENERATION_DIGITS = 32;
