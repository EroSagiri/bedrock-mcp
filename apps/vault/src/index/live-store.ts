import type { ParsedDocument } from "./parse";

/**
 * The live note index schema.
 *
 * Every table here describes the **current** state of one document, and nothing carries a generation:
 * the index is no longer a snapshot rebuilt wholesale but a materialized view each document updates
 * independently. The two metadata columns on `documents` are its commit marker — `indexed_etag` and
 * `index_version` are only ever written by the transaction that wrote every derived row, so "the index
 * says this document is current" cannot be true while its full text, tags, or links are missing.
 */
export const INDEX_SCHEMA_VERSION = 1;

/** Bumped whenever a parser change means every document must be re-derived even if R2 did not move. */
export const CURRENT_INDEX_VERSION = 1;

export const LIVE_INDEX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    indexed_etag TEXT,
    content_sha256 TEXT,
    title TEXT,
    content_type TEXT,
    modified TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT,
    index_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS documents_key ON documents(key);
  CREATE INDEX IF NOT EXISTS documents_modified ON documents(modified DESC);
  CREATE INDEX IF NOT EXISTS documents_version ON documents(index_version);

  CREATE TABLE IF NOT EXISTS document_headings (
    document_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL,
    line INTEGER NOT NULL,
    PRIMARY KEY (document_id, ordinal)
  );

  CREATE TABLE IF NOT EXISTS frontmatter_values (
    document_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (document_id, field)
  );

  CREATE TABLE IF NOT EXISTS document_tags (
    document_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    source TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    PRIMARY KEY (document_id, tag, source)
  );
  CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag);

  CREATE TABLE IF NOT EXISTS links (
    document_id INTEGER NOT NULL,
    to_key TEXT NOT NULL,
    PRIMARY KEY (document_id, to_key)
  );
  CREATE INDEX IF NOT EXISTS links_to ON links(to_key);

  -- Ordinary FTS5, not contentless: a search result must be renderable from the index alone, without a
  -- second trip to R2 for a snippet. The vault is small enough that storing the text twice is not worth
  -- optimizing away; if that changes, this becomes external-content or contentless instead.
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, path UNINDEXED, headings, tags, body, tokenize = 'unicode61'
  );
`;

/** Everything the index knows about one document after a successful commit. */
export type IndexedDocument = ParsedDocument & {
  etag: string;
  /** Size in bytes, as R2 reports it. Named `size` to match the column it fills. */
  size: number;
  contentType: string | null;
  modified: string;
  contentSha256: string;
};

/** What the index currently believes about a path. */
export type FreshnessRow = {
  id: number;
  key: string;
  indexedEtag: string | null;
  indexVersion: number;
  indexedAt: string | null;
  modified: string | null;
};

/**
 * The single freshness invariant: a document is current when R2 still holds the revision the index
 * observed **and** that observation was produced by the current parser and indexer.
 *
 * `absent` and `missing` are different answers: the first means the object is gone and the index says
 * so, the second means the index has never successfully published a revision for a path that exists.
 */
export function freshnessStatus(
  row: FreshnessRow | undefined,
  observedEtag: string | null,
  indexVersion = CURRENT_INDEX_VERSION,
): "fresh" | "absent" | "stale" | "outdated" | "missing" {
  if (!row) return observedEtag === null ? "absent" : "missing";
  if (observedEtag === null) return "stale";
  if (row.indexedEtag !== observedEtag) return "stale";
  return row.indexVersion === indexVersion ? "fresh" : "outdated";
}
