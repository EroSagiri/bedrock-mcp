import { canonicalVaultPath, isCanonicalVaultPath } from "./paths.js";

/**
 * The logical-deletion record, shared by every component that has to read or write one.
 *
 * It used to live only in the Obsidian plugin, which was consistent while the plugin was the only
 * writer. The hot checkpoint path breaks that: the Vault must be able to ask "is this path
 * *effectively* deleted?" before it writes a checkpoint, and a second implementation of the same key
 * derivation would be a silent correctness bug — two components computing two different tombstone
 * names for one deletion.
 *
 * A tombstone is immutable and version-bound: it names the exact remote revision it retires, so a
 * later re-upload of the same path is a *different* object version and is not hidden by the old
 * record.
 */

/** Reserved below every configured remote prefix. It is never a Vault document path. */
export const TOMBSTONE_NAMESPACE = ".mineral-sync/tombstones/";
export const TOMBSTONE_PROTOCOL = 1;

export interface RemoteTombstone {
  protocol: typeof TOMBSTONE_PROTOCOL;
  path: string;
  deletedRemoteETag: string;
  createdAt: string;
}

export function isInternalRemoteKey(key: string): boolean {
  return key.startsWith(TOMBSTONE_NAMESPACE);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * The metadata-object key for one `(path, revision)` pair.
 *
 * `undefined` when the inputs are not canonical, so a caller cannot write a tombstone under a key it
 * will never be able to compute again.
 */
export async function tombstoneKey(path: string, deletedRemoteETag: string): Promise<string | undefined> {
  if (!isCanonicalVaultPath(path) || !deletedRemoteETag) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${path}\u0000${deletedRemoteETag}`));
  return `${TOMBSTONE_NAMESPACE}${base64url(new Uint8Array(digest))}.json`;
}

export function encodeTombstone(record: RemoteTombstone): Uint8Array {
  validateTombstone(record);
  return new TextEncoder().encode(JSON.stringify(record));
}

/** Fail closed: malformed metadata never means a user object was deleted. */
export function parseTombstone(body: ArrayBuffer | Uint8Array | string): RemoteTombstone {
  let value: unknown;
  try {
    value = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    throw new Error("Malformed tombstone JSON");
  }
  validateTombstone(value);
  return value;
}

export function validateTombstone(value: unknown): asserts value is RemoteTombstone {
  if (!value || typeof value !== "object") throw new Error("Malformed tombstone record");
  const record = value as Partial<RemoteTombstone>;
  if (record.protocol !== TOMBSTONE_PROTOCOL || typeof record.path !== "string" || typeof record.deletedRemoteETag !== "string" || !record.deletedRemoteETag || typeof record.createdAt !== "string" || !record.createdAt) throw new Error("Unsupported or incomplete tombstone record");
  if (!isCanonicalVaultPath(record.path) || canonicalVaultPath(record.path) !== record.path || isInternalRemoteKey(record.path)) throw new Error("Tombstone contains an invalid path");
  if (!Number.isFinite(Date.parse(record.createdAt))) throw new Error("Tombstone has an invalid creation time");
}
