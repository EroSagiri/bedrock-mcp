/**
 * The one canonicalization rule for a vault-relative object path.
 *
 * It lives in `sync-core` because the plugin, the Gateway, and the Vault all address the same R2
 * objects by this string: a path is a namespace key, and two components that disagree about a
 * backslash or a leading slash would silently address different objects. The rule is deliberately
 * identical to the plugin's historical `canonicalKey()`, which now delegates here.
 */

/** Matches the bound the mutation journal already carries. */
export const MAX_VAULT_PATH_LENGTH = 4096;

export function isCanonicalVaultPath(value: unknown): value is string {
  return typeof value === "string" && canonicalVaultPath(value) === value;
}

/**
 * `undefined` for anything that is not a canonical path, so a caller can never store a near-miss.
 *
 * Rejects empty segments (`a//b`, a trailing slash), `.`/`..` traversal, NUL, and over-long values,
 * because all of those would either escape the prefix or address a key no other component computes.
 */
export function canonicalVaultPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > MAX_VAULT_PATH_LENGTH) return undefined;
  if (value.includes("\0")) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > MAX_VAULT_PATH_LENGTH) return undefined;
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") return undefined;
  }
  return normalized;
}

/**
 * A prefix in the form every object key is composed with: canonical, empty, or ending in exactly one
 * slash.
 *
 * The Vault and the plugin have to agree on this as well as on the path rule — a prefix that differs
 * by one slash is a different namespace, and the failure mode is silence rather than an error.
 * `undefined` means "not a prefix at all"; the empty string is a valid prefix and means the bucket
 * root.
 */
export function normalizeRemotePrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.trim()) return "";
  const canonical = canonicalVaultPath(value.replace(/\/+$/, ""));
  return canonical === undefined ? undefined : `${canonical}/`;
}

export function remoteObjectKey(prefix: unknown, vaultKey: unknown): string | undefined {
  const normalizedPrefix = normalizeRemotePrefix(prefix);
  const canonical = canonicalVaultPath(vaultKey);
  if (normalizedPrefix === undefined || canonical === undefined) return undefined;
  return normalizedPrefix + canonical;
}

/** The inverse of `remoteObjectKey`; `undefined` when the key is not inside this prefix. */
export function vaultKeyFromRemoteObjectKey(prefix: unknown, objectKey: unknown): string | undefined {
  const normalizedPrefix = normalizeRemotePrefix(prefix);
  if (normalizedPrefix === undefined || typeof objectKey !== "string") return undefined;
  if (normalizedPrefix && !objectKey.startsWith(normalizedPrefix)) return undefined;
  return canonicalVaultPath(objectKey.slice(normalizedPrefix.length));
}
