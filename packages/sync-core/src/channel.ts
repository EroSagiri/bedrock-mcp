/**
 * Canonical, credential-free channel identity and channel derivation.
 *
 * This module is the single authority for turning an endpoint/bucket/prefix triple into a channel.
 * The plugin, the Gateway, and any future Vault writer must all feed the same triple into
 * `canonicalChannelInput`, or they will silently subscribe to different channels.
 *
 * `accessKeyId`, `secretAccessKey`, request headers, and Gateway credentials never participate:
 * a channel is not a secret, and it must not be derivable from one.
 */

/** The versioned input domain separator from the Phase 4A contract. */
export const CHANNEL_INPUT_VERSION = "v1";

/** Unpadded base64url over a 32-byte digest is always exactly 43 characters. */
export const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type CanonicalRemoteIdentity = { endpoint: string; bucket: string; remotePrefix: string };

export function isRemoteChangeChannel(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_PATTERN.test(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Mirrors the plugin's existing `remoteIdentity().endpoint` normalization exactly: parse the URL,
 * re-serialize it, then drop a single trailing slash. The value is **not** trimmed here — the
 * caller's own trim supplies that — so that this function and the plugin's `remoteIdentity()`
 * cannot disagree about a value that survived settings parsing.
 *
 * An unparseable value stays literal (minus trailing slashes) so that two clients given the same
 * broken endpoint still agree on one channel instead of one of them subscribing to nothing.
 */
export function canonicalEndpoint(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  try { return new URL(raw).toString().replace(/\/$/, ""); } catch { return raw.replace(/\/+$/, ""); }
}

/**
 * Mirrors the plugin's existing `normalizePrefix`: strip surrounding slashes and keep exactly one
 * trailing slash, so that `""`, `"a"`, and `"a/"` cannot be confused with `"a/b"`.
 */
export function canonicalPrefix(value: unknown): string {
  const raw = text(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return raw ? `${raw}/` : "";
}

/** Length-prefixed, so no combination of field values can be confused with another combination. */
function segment(value: string): string {
  return `${value.length}:${value}`;
}

/** The exact string that is hashed. Stability of this function is a protocol commitment. */
export function canonicalChannelInput(identity: CanonicalRemoteIdentity): string {
  // The API boundary trims, exactly as the plugin's settings UI does.
  return [
    CHANNEL_INPUT_VERSION,
    segment(canonicalEndpoint(text(identity.endpoint))),
    segment(text(identity.bucket)),
    segment(canonicalPrefix(identity.remotePrefix)),
  ].join(":");
}

const encoder = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * SHA-256 → unpadded base64url. A 32-byte digest always encodes to exactly 43 characters, which is
 * what `CHANNEL_PATTERN` requires. Web Crypto is used deliberately: it exists in Cloudflare Workers,
 * Node, Obsidian desktop, and the Android WebView, so no platform branch is needed.
 */
export async function deriveRemoteChangeChannel(identity: CanonicalRemoteIdentity): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalChannelInput(identity)));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A short, non-reversible display form. Diagnostics may show this; they must never show the
 * endpoint, bucket, or prefix it was derived from.
 */
export function safeChannelFingerprint(channel: string): string {
  return channel.slice(0, 6);
}

export function looksBase64Url(value: string): boolean {
  return BASE64URL.test(value);
}
