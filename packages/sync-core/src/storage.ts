/** Shared internal storage namespace; none of these objects are user documents. */
export const MINERAL_NAMESPACE = ".mineral/";
export const VERSION_NAMESPACE = `${MINERAL_NAMESPACE}versions/`;
export const LEGACY_TOMBSTONE_NAMESPACE = ".mineral-sync/tombstones/";
export const LEGACY_VERSION_NAMESPACES = [".history/", ".trash/"] as const;

export function isSystemStorageKey(key: string): boolean {
  return [MINERAL_NAMESPACE, ".mineral-sync/", ".system/", ...LEGACY_VERSION_NAMESPACES]
    .some(prefix => key === prefix.slice(0, -1) || key.startsWith(prefix));
}

/** The unique component prevents two saves in the same millisecond from replacing each other. */
export function versionKey(path: string, at = new Date(), id = crypto.randomUUID()): string {
  return `${VERSION_NAMESPACE}${at.toISOString().replace(/[:.]/g, "-")}-${id}/${path}`;
}

export function versionSourcePath(key: string): string | undefined {
  const prefix = [VERSION_NAMESPACE, ...LEGACY_VERSION_NAMESPACES].find(value => key.startsWith(value));
  if (!prefix) return undefined;
  const remainder = key.slice(prefix.length);
  const slash = remainder.indexOf("/");
  return slash > 0 && slash < remainder.length - 1 ? remainder.slice(slash + 1) : undefined;
}
