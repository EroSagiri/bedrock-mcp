/**
 * How well a filename matches, which is a navigation signal rather than a relevance score.
 *
 * A query is often a clue the caller remembers rather than a phrase in the text: a date, a title fragment,
 * the first half of a note's name. `2026-06` should find `daily/2026-06-18.md` and be *seen* to find it,
 * so a strong name match has to be able to outrank a document where the same six characters happen to sit
 * in a paragraph. A weak one — the query buried in a directory name — should not.
 *
 * That is the whole reason this is graded instead of boolean: a single `matched: true` would make the
 * merge unable to tell "the note is called this" from "this appears somewhere in its path".
 */
export type NameQuality = "exact" | "prefix" | "substring" | "path";

/**
 * Where each signal sits relative to a full-text hit.
 *
 * Content sits between the two name signals on purpose. A filename the caller all but named is a stronger
 * signal than a phrase in a body; a substring that happens to occur somewhere in a path is weaker. This is
 * the "适度优先" line: strong name matches are boosted, and the rest are not lifted wholesale above the
 * full-text ranking.
 */
export const MATCH_TIER = { name: { exact: 0, prefix: 1, substring: 3, path: 4 }, content: 2 } as const;

export type MatchSignal = "name" | "content";

/** Text extensions a note's name can carry, stripped only to compare the title itself. */
const TEXT_EXTENSION = /\.(md|markdown|mdx|txt)$/i;

/**
 * Grades one key against one query, or `null` when the key does not actually contain it.
 *
 * `null` matters: the filename projection is a `LIKE` over the whole key, so a key that arrives here has
 * matched *something*, and a caller that filtered it out would be left wondering where it went.
 */
export function nameMatchQuality(key: string, query: string): NameQuality | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const lower = key.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;
  const stem = basename.replace(TEXT_EXTENSION, "");
  if (stem === needle || basename === needle) return "exact";
  if (stem.startsWith(needle) || basename.startsWith(needle)) return "prefix";
  if (stem.includes(needle) || basename.includes(needle)) return "substring";
  return lower.includes(needle) ? "path" : null;
}

/** The tier a set of signals earns: the strongest one present, and the order they are reported in. */
export function matchSignals(signals: { name: NameQuality | null; content: boolean }): { tier: number; matched: MatchSignal[] } {
  const entries: Array<{ signal: MatchSignal; tier: number }> = [];
  if (signals.name) entries.push({ signal: "name", tier: MATCH_TIER.name[signals.name] });
  if (signals.content) entries.push({ signal: "content", tier: MATCH_TIER.content });
  entries.sort((left, right) => left.tier - right.tier);
  return { tier: entries[0]?.tier ?? MATCH_TIER.content, matched: entries.map(entry => entry.signal) };
}
