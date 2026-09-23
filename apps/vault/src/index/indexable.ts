import { isTextDocumentKey } from "@mineral/core/keys";

/**
 * What may be indexed at all — by the note index **and** by the vector index.
 *
 * It lives in one place because the two must agree: a document the note index refuses to hold can never
 * be a semantic hit either, and a path that only one of them skips would leave the other reporting a
 * document that does not exist as far as search is concerned.
 *
 * `.history/` and `.trash/` are the vault's own bookkeeping — a backup of a note is not the note — and
 * `.system/` holds machine-written state, not knowledge.
 */
const SYSTEM_PREFIXES = [".history/", ".trash/", ".system/"] as const;

export function isIndexable(key: string): boolean {
  return isTextDocumentKey(key) && !SYSTEM_PREFIXES.some(prefix => key.startsWith(prefix));
}
