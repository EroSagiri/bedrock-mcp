import { isTextDocumentKey } from "@mineral/core/keys";
import { isSystemStorageKey } from "@mineral/sync-core/storage";

/**
 * What may be indexed at all — by the note index **and** by the vector index.
 *
 * It lives in one place because the two must agree: a document the note index refuses to hold can never
 * be a semantic hit either, and a path that only one of them skips would leave the other reporting a
 * document that does not exist as far as search is concerned.
 *
 * `.mineral/` holds versions, tombstones and verification material, none of which is knowledge.
 * Legacy namespaces remain excluded while deployed clients and stored objects are migrated.
 */

export function isIndexable(key: string): boolean {
  return isTextDocumentKey(key) && !isSystemStorageKey(key);
}
