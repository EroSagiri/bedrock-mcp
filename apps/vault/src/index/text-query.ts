/**
 * How a search box's text becomes a query.
 *
 * SQLite's FTS5 tokenizer (`unicode61`) is word-oriented: it treats a run of CJK characters between two
 * punctuation marks as **one token**. In a Chinese vault that makes full-text search useless — searching
 * 心率 finds nothing when the note says "实时查看心率的工具", because 心率 is not a token, it is a fragment
 * of one. Only a whole delimited run (or a whole frontmatter tag, which is space-separated) ever matches.
 *
 * So a query is split in two: Latin terms go to FTS5, which handles them properly, and CJK runs are
 * matched as **substrings** by SQLite itself. That is exact rather than approximate — a bigram index would
 * be a guess at where Chinese words end — and it does not depend on the tokenizer at all, so it behaves
 * identically in the local engine and in production.
 *
 * The other half of this module exists because a query is otherwise passed to `MATCH` verbatim, and FTS5
 * has a query language: `probe-tag` means "probe NOT tag", `"unclosed` is a syntax error, and `*` or `:`
 * silently change the question. Every term is therefore quoted, and only a standalone uppercase AND / OR /
 * NOT survives as an operator.
 */

/** Han, kana, bopomofo and hangul: what a word-oriented tokenizer will not split. */
const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
/** What FTS5 will tokenize into a term, and therefore what can be quoted and handed to it. */
const TERM_CHARACTER = /[A-Za-z0-9_]/;
/** Kept as operators because they are the useful part of the FTS5 query language, and only uppercase. */
const OPERATORS = new Set(["AND", "OR", "NOT"]);

export type TextQueryPlan = {
  /** The FTS5 expression for the Latin part, or `null` when the query has none. */
  match: string | null;
  /** CJK runs, each of which must appear as a substring of the document's text. */
  cjkRuns: string[];
  /** The longest CJK run: what a snippet is anchored on and what the ranking is computed from. */
  anchor: string | null;
  /** `true` when the substring path is needed at all. */
  hasCjk: boolean;
  /** `true` when nothing searchable survived — an empty query, or one made only of punctuation. */
  empty: boolean;
};

type Segment = { kind: "term" | "cjk" | "op"; value: string };

function segment(query: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  while (index < query.length) {
    const character = query[index]!;
    if (CJK_CHARACTER.test(character)) {
      let run = "";
      while (index < query.length && CJK_CHARACTER.test(query[index]!)) run += query[index++]!;
      segments.push({ kind: "cjk", value: run });
      continue;
    }
    if (TERM_CHARACTER.test(character)) {
      let word = "";
      while (index < query.length && TERM_CHARACTER.test(query[index]!)) word += query[index++]!;
      segments.push(OPERATORS.has(word) ? { kind: "op", value: word } : { kind: "term", value: word });
      continue;
    }
    // Everything else — whitespace, punctuation, symbols — separates.
    index++;
  }
  return segments;
}

/** Quotes a term, so no character of it can be read as FTS5 syntax. */
function quoted(term: string): string {
  return `"${term}"`;
}

/**
 * Builds the FTS5 expression from the **Latin terms only**.
 *
 * A CJK run is deliberately left out: it is not a token, so asking FTS5 for it answers "no" for every
 * note that contains the word inside a sentence — and because it would be ANDed with the rest, that "no"
 * would silently empty the whole result set. The substring conditions cover it instead.
 */
function buildMatch(segments: Segment[]): string | null {
  const parts: string[] = [];
  let previousWasOperand = false;
  for (const item of segments) {
    if (item.kind === "cjk") continue;
    if (item.kind === "op") {
      // A dangling operator is dropped rather than handed to FTS5, where it is a syntax error.
      if (!previousWasOperand || parts.length === 0) continue;
      // `NOT` is binary in FTS5, and a repeated operator is a typo, not a question.
      if (parts[parts.length - 1] === item.value) continue;
      parts.push(item.value);
      previousWasOperand = false;
      continue;
    }
    if (previousWasOperand) parts.push("AND");
    parts.push(quoted(item.value));
    previousWasOperand = true;
  }
  while (parts.length > 0 && OPERATORS.has(parts[parts.length - 1]!)) parts.pop();
  return parts.length > 0 ? parts.join(" ") : null;
}

export function planTextQuery(query: string): TextQueryPlan {
  const segments = segment(query.trim());
  const cjkRuns = segments.filter(item => item.kind === "cjk").map(item => item.value);
  const anchor = cjkRuns.reduce<string | null>((longest, run) => (longest === null || run.length > longest.length ? run : longest), null);
  const match = buildMatch(segments);
  return { match, cjkRuns, anchor, hasCjk: cjkRuns.length > 0, empty: match === null && cjkRuns.length === 0 };
}
