import type { SqlDatabase } from "../index/journal-store";
import { isCurrentRevision, type VectorRevision } from "./schema";

/**
 * The vector layer's durable state.
 *
 * Three tables, and the division between them is the whole design:
 *
 * - `pending_vector` is the **work owed**, materialised. It is written in the same transaction as the
 *   Mutation Journal and `pending_index` — a committed write that forgot its vector debt would be
 *   invisible until the next audit, and the audit runs nightly.
 * - `document_vector_state` is what has actually been **published**: the revision whose chunks are all
 *   in Vectorize (`active_*`), the revision a publish attempt is aiming at (`desired_*`), and whether
 *   the active revision is complete (`status`). It is separate from `pending_vector` because a failed
 *   vector publish must not re-dirty the note index, and because "what is owed" is not "what is there".
 * - `vector_chunks` is the **ledger**: every chunk id currently upserted into Vectorize, with its text.
 *   It is the only thing that can clean up after a crash, because Vectorize has no listing API — a
 *   vector whose id is not written down can never be found again. It also holds the chunk text, so a
 *   semantic result is renderable without a second trip to R2.
 *
 * The tables deliberately have no foreign keys and no cascades. `documents.id` is `AUTOINCREMENT`, so a
 * deleted note's id is never handed to a new one, and the vector layer removes its own rows in its own
 * order: deleting a ledger row before its vector is gone from Vectorize would lose the only record of
 * what still needs deleting.
 */
export const VECTOR_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_vector (
    path TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    target_etag TEXT,
    source TEXT NOT NULL,
    not_before INTEGER NOT NULL,
    first_dirty_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_claim_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS pending_vector_due ON pending_vector(not_before, updated_at);

  CREATE TABLE IF NOT EXISTS document_vector_state (
    document_id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    desired_content_sha256 TEXT,
    desired_chunker_version INTEGER,
    desired_embedding_model TEXT,
    desired_vector_version INTEGER,
    desired_chunk_count INTEGER,
    active_content_sha256 TEXT,
    active_chunker_version INTEGER,
    active_embedding_model TEXT,
    active_vector_version INTEGER,
    active_chunk_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS document_vector_state_key ON document_vector_state(key);
  CREATE INDEX IF NOT EXISTS document_vector_state_status ON document_vector_state(status);

  CREATE TABLE IF NOT EXISTS vector_chunks (
    chunk_id TEXT PRIMARY KEY,
    document_id INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vector_chunks_document ON vector_chunks(document_id);
  CREATE INDEX IF NOT EXISTS vector_chunks_revision ON vector_chunks(document_id, content_sha256);
`;

export type VectorStatus = "pending" | "ready";

export type VectorDocumentState = {
  documentId: number;
  key: string;
  status: VectorStatus;
  /** The revision the last attempt observed. Never servable on its own — only `active` is. */
  desired: VectorRevision | null;
  desiredChunkCount: number | null;
  active: VectorRevision | null;
  activeChunkCount: number;
  updatedAt: number;
  attempts: number;
  lastError: string | null;
};

/** One identified chunk, as the publish transaction writes it. */
export type VectorChunkRow = {
  chunkId: string;
  ordinal: number;
  heading: string;
  text: string;
};

export type VectorQueueSummary = {
  due: number;
  upserts: number;
  removes: number;
  earliestNotBefore: number | null;
};

export type DueVectorIntent = { path: string; action: "upsert" | "remove"; targetEtag: string | null };

export type VectorClaim =
  | { status: "claimed"; attempts: number }
  | { status: "superseded" }
  | { status: "missing" };

export type VectorHealth = {
  tracked: number;
  ready: number;
  pending: number;
  /** Documents whose active revision is in Vectorize but built by a different chunker or model. */
  outdated: number;
  ledgerChunks: number;
  failed: number;
  lastError: string | null;
};

type StateRow = {
  document_id: number;
  key: string;
  status: string;
  desired_content_sha256: string | null;
  desired_chunker_version: number | null;
  desired_embedding_model: string | null;
  desired_vector_version: number | null;
  desired_chunk_count: number | null;
  active_content_sha256: string | null;
  active_chunker_version: number | null;
  active_embedding_model: string | null;
  active_vector_version: number | null;
  active_chunk_count: number;
  updated_at: number;
  attempts: number;
  last_error: string | null;
};

type QueueRow = {
  path: string;
  action: string;
  target_etag: string | null;
  not_before: number;
  attempts: number;
};

function stateFrom(row: StateRow): VectorDocumentState {
  const desired = row.desired_content_sha256 === null
    ? null
    : { contentSha256: row.desired_content_sha256, chunkerVersion: Number(row.desired_chunker_version ?? 0), embeddingModel: row.desired_embedding_model ?? "", vectorVersion: Number(row.desired_vector_version ?? 0) };
  const active = row.active_content_sha256 === null
    ? null
    : { contentSha256: row.active_content_sha256, chunkerVersion: Number(row.active_chunker_version ?? 0), embeddingModel: row.active_embedding_model ?? "", vectorVersion: Number(row.active_vector_version ?? 0) };
  return {
    documentId: Number(row.document_id),
    key: String(row.key),
    status: row.status === "ready" ? "ready" : "pending",
    desired,
    desiredChunkCount: row.desired_chunk_count === null ? null : Number(row.desired_chunk_count),
    active,
    activeChunkCount: Number(row.active_chunk_count),
    updatedAt: Number(row.updated_at),
    attempts: Number(row.attempts),
    lastError: row.last_error,
  };
}

export class SqlVectorStore {
  constructor(private readonly db: SqlDatabase) {
    for (const statement of VECTOR_STATE_SCHEMA.split(";")) if (statement.trim()) this.db.exec(statement);
  }

  private first<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): T | undefined {
    return [...this.db.exec<T>(query, ...bindings)][0];
  }

  // ---------------------------------------------------------------------------------------------
  // The dirty set: written with the mutation fact, drained by the scheduler.
  // ---------------------------------------------------------------------------------------------

  /**
   * Adds vector work for one path, coalescing with what is already owed.
   *
   * Identical to the note index's rule, deliberately: the newest action and target win, `not_before`
   * only moves forward, and a new arrival clears the backoff — because it is new information about a
   * path that was previously failing.
   */
  enqueueWithinTransaction(spec: { path: string; action: "upsert" | "remove"; targetEtag: string | null; notBefore: number }, source: string): void {
    this.upsertIntent(spec, source);
  }

  /**
   * The correction path: enqueues every document whose vectors are not what the frozen schema would
   * produce.
   *
   * It runs at the end of an audit, and it is the only thing that notices a change no writer reported —
   * a bumped chunker, a re-embedded model, an interrupted publish. It asks about the *index's* documents
   * rather than walking R2 again, because the note index has already answered "what is in the vault".
   *
   * The candidates are selected first and enqueued one by one. That is not for performance — it is so the
   * count this returns is the number of documents actually enqueued: an `INSERT ... SELECT` reports a
   * row count that includes every index it touched, which made a sweep of 391 documents look like a
   * sweep of 1173.
   */
  enqueueStale(now: number, revision: { chunkerVersion: number; embeddingModel: string; vectorVersion: number }): number {
    const stale = [...this.db.exec<{ key: string; indexed_etag: string | null }>(
      `SELECT d.key, d.indexed_etag
       FROM documents d
       LEFT JOIN document_vector_state s ON s.document_id = d.id
       WHERE s.document_id IS NULL
          OR s.status <> 'ready'
          OR s.active_chunker_version IS NOT ?
          OR s.active_embedding_model IS NOT ?
          OR s.active_vector_version IS NOT ?
          OR s.active_content_sha256 IS NOT d.content_sha256`,
      revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion,
    )];
    for (const row of stale) this.upsertIntent({ path: row.key, action: "upsert", targetEtag: row.indexed_etag, notBefore: now }, "system");
    return stale.length;
  }

  /**
   * The one place a dirty entry is written.
   *
   * `not_before` only ever moves forward, so a debounce window that was already pushed out cannot be
   * pulled back in — and an audit cannot shorten a backoff a failing path has earned.
   */
  private upsertIntent(spec: { path: string; action: "upsert" | "remove"; targetEtag: string | null; notBefore: number }, source: string): void {
    const now = Date.now();
    this.db.exec(
      `INSERT INTO pending_vector (path, action, target_etag, source, not_before, first_dirty_at, updated_at, attempts, last_claim_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(path) DO UPDATE SET
         action = excluded.action,
         target_etag = excluded.target_etag,
         source = excluded.source,
         not_before = MAX(pending_vector.not_before, excluded.not_before),
         updated_at = excluded.updated_at,
         attempts = 0,
         last_claim_at = NULL,
         last_error = NULL`,
      spec.path,
      spec.action,
      spec.action === "remove" ? null : spec.targetEtag,
      source,
      Math.max(spec.notBefore, 0),
      now,
      now,
    );
  }

  pendingSummary(now: number): VectorQueueSummary {
    const row = this.first<{ due: number; upserts: number; removes: number; earliest: number | null }>(
      `SELECT SUM(CASE WHEN not_before <= ? THEN 1 ELSE 0 END) due,
              SUM(CASE WHEN action = 'upsert' THEN 1 ELSE 0 END) upserts,
              SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) removes,
              MIN(not_before) earliest
       FROM pending_vector`,
      now,
    );
    return { due: Number(row?.due ?? 0), upserts: Number(row?.upserts ?? 0), removes: Number(row?.removes ?? 0), earliestNotBefore: row?.earliest ?? null };
  }

  listDuePaths(now: number, limit: number): DueVectorIntent[] {
    return [...this.db.exec<QueueRow>(
      "SELECT * FROM pending_vector WHERE not_before <= ? ORDER BY updated_at, path LIMIT ?",
      now,
      Math.max(1, Math.floor(limit)),
    )].map(row => ({ path: row.path, action: row.action === "remove" ? "remove" : "upsert", targetEtag: row.target_etag }));
  }

  /** Claims one due intent while it is still exactly the intent the caller saw, as the note index does. */
  claim(input: { path: string; etag: string | null; action: "upsert" | "remove"; now: number }): VectorClaim {
    const written = writtenBy(this.db.exec(
      `UPDATE pending_vector SET attempts = attempts + 1, last_claim_at = ?
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ? AND not_before <= ?`,
      input.now, input.path, input.action, input.etag ?? "", input.now,
    ));
    if (written === 0) {
      return this.first<QueueRow>("SELECT * FROM pending_vector WHERE path = ?", input.path) ? { status: "superseded" } : { status: "missing" };
    }
    const row = this.first<QueueRow>("SELECT * FROM pending_vector WHERE path = ?", input.path)!;
    return { status: "claimed", attempts: Number(row.attempts) };
  }

  complete(input: { path: string; etag: string | null; action: "upsert" | "remove" }): boolean {
    return writtenBy(this.db.exec(
      `DELETE FROM pending_vector
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ?
         AND (last_claim_at IS NULL OR updated_at <= last_claim_at)`,
      input.path, input.action, input.etag ?? "",
    )) > 0;
  }

  fail(input: { path: string; etag: string | null; action: "upsert" | "remove"; error: string; notBefore: number }): void {
    this.db.exec(
      `UPDATE pending_vector SET last_error = ?, last_claim_at = NULL, not_before = MAX(not_before, ?)
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ?`,
      input.error.slice(0, 200), input.notBefore, input.path, input.action, input.etag ?? "",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Publish state and the ledger.
  // ---------------------------------------------------------------------------------------------

  stateForDocument(documentId: number): VectorDocumentState | undefined {
    const row = this.first<StateRow>("SELECT * FROM document_vector_state WHERE document_id = ?", documentId);
    return row && stateFrom(row);
  }

  stateForKey(key: string): VectorDocumentState | undefined {
    const row = this.first<StateRow>("SELECT * FROM document_vector_state WHERE key = ? ORDER BY updated_at DESC LIMIT 1", key);
    return row && stateFrom(row);
  }

  /**
   * Records that a publish has started, before any embedding or network call.
   *
   * `desired_*` is what makes an interrupted publish visible: a row left in `pending` with a desired
   * revision is exactly "this document had work in flight when the runtime stopped".
   *
   * `status` is only demoted when the row has nothing servable. A re-publish of a document whose active
   * revision is still current must not hide it — the old vectors remain valid until the new ones are
   * published, which is the entire point of publishing in one transaction.
   */
  beginAttempt(documentId: number, key: string, desired: VectorRevision, chunkCount: number, now: number): void {
    const existing = this.stateForDocument(documentId);
    // The only condition that may keep serving the old revision is that the old revision is itself
    // complete and was produced by the current chunker and model.
    const servable = existing?.status === "ready" && isCurrentRevision(existing.active);
    if (!existing) {
      this.db.exec(
        `INSERT INTO document_vector_state
           (document_id, key, status, desired_content_sha256, desired_chunker_version, desired_embedding_model, desired_vector_version, desired_chunk_count, active_chunk_count, updated_at, attempts, last_error)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, 1, NULL)`,
        documentId, key, desired.contentSha256, desired.chunkerVersion, desired.embeddingModel, desired.vectorVersion, chunkCount, now,
      );
      return;
    }
    this.db.exec(
      `UPDATE document_vector_state
       SET key = ?, status = ?, desired_content_sha256 = ?, desired_chunker_version = ?, desired_embedding_model = ?, desired_vector_version = ?,
           desired_chunk_count = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE document_id = ?`,
      key, servable ? "ready" : "pending", desired.contentSha256, desired.chunkerVersion, desired.embeddingModel, desired.vectorVersion,
      chunkCount, now, documentId,
    );
  }

  recordFailure(documentId: number, key: string, error: string, now: number): void {
    const existing = this.stateForDocument(documentId);
    if (!existing) {
      this.db.exec(
        `INSERT INTO document_vector_state (document_id, key, status, desired_chunk_count, active_chunk_count, updated_at, attempts, last_error)
         VALUES (?, ?, 'pending', NULL, 0, ?, 1, ?)`,
        documentId, key, now, error.slice(0, 200),
      );
      return;
    }
    this.db.exec("UPDATE document_vector_state SET last_error = ?, updated_at = ? WHERE document_id = ?", error.slice(0, 200), now, documentId);
  }

  /**
   * The publish point.
   *
   * Everything here is one transaction: the new revision's ledger rows and the state row that makes them
   * servable. Nothing may read "the active revision is X" while some of X's chunks are missing, and
   * nothing may serve a chunk that has no ledger row. The old revision's rows are deliberately left
   * alone: they are still in Vectorize, and they are the only record of what has to be deleted.
   */
  publishRevision(documentId: number, key: string, revision: VectorRevision, chunks: VectorChunkRow[], now: number): void {
    for (const chunk of chunks) {
      this.db.exec(
        `INSERT INTO vector_chunks (chunk_id, document_id, content_sha256, ordinal, heading, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET document_id = excluded.document_id, ordinal = excluded.ordinal, heading = excluded.heading, text = excluded.text`,
        chunk.chunkId, documentId, revision.contentSha256, chunk.ordinal, chunk.heading, chunk.text, now,
      );
    }
    this.db.exec(
      `INSERT INTO document_vector_state
         (document_id, key, status, desired_content_sha256, desired_chunker_version, desired_embedding_model, desired_vector_version, desired_chunk_count,
          active_content_sha256, active_chunker_version, active_embedding_model, active_vector_version, active_chunk_count, updated_at, attempts, last_error)
       VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(document_id) DO UPDATE SET
         key = excluded.key,
         status = 'ready',
         desired_content_sha256 = excluded.desired_content_sha256,
         desired_chunker_version = excluded.desired_chunker_version,
         desired_embedding_model = excluded.desired_embedding_model,
         desired_vector_version = excluded.desired_vector_version,
         desired_chunk_count = excluded.desired_chunk_count,
         active_content_sha256 = excluded.active_content_sha256,
         active_chunker_version = excluded.active_chunker_version,
         active_embedding_model = excluded.active_embedding_model,
         active_vector_version = excluded.active_vector_version,
         active_chunk_count = excluded.active_chunk_count,
         updated_at = excluded.updated_at,
         attempts = 0,
         last_error = NULL`,
      documentId, key,
      revision.contentSha256, revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion, chunks.length,
      revision.contentSha256, revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion, chunks.length, now,
    );
  }

  /** Advances `desired_*` for a document whose content did not change, without touching the ledger. */
  recordNoop(documentId: number, desired: VectorRevision, now: number): void {
    this.db.exec(
      `UPDATE document_vector_state
       SET desired_content_sha256 = ?, desired_chunker_version = ?, desired_embedding_model = ?, desired_vector_version = ?, updated_at = ?, last_error = NULL
       WHERE document_id = ?`,
      desired.contentSha256, desired.chunkerVersion, desired.embeddingModel, desired.vectorVersion, now, documentId,
    );
  }

  chunksOfRevision(documentId: number, contentSha256: string): VectorChunkRow[] {
    return [...this.db.exec<{ chunk_id: string; ordinal: number; heading: string; text: string }>(
      "SELECT chunk_id, ordinal, heading, text FROM vector_chunks WHERE document_id = ? AND content_sha256 = ? ORDER BY ordinal",
      documentId, contentSha256,
    )].map(row => ({ chunkId: row.chunk_id, ordinal: Number(row.ordinal), heading: row.heading, text: row.text }));
  }

  chunkIdsOfDocument(documentId: number): string[] {
    return [...this.db.exec<{ chunk_id: string }>("SELECT chunk_id FROM vector_chunks WHERE document_id = ?", documentId)].map(row => row.chunk_id);
  }

  /**
   * The cleanup work list: ledger rows that the active revision does not claim.
   *
   * These are the chunks of a superseded revision, or of a document that is gone. They are found by
   * comparing the ledger with the state, never by walking Vectorize — which is why deleting a ledger row
   * is the *last* step of a cleanup and never the first.
   */
  staleLedger(limit: number): Array<{ chunkId: string; documentId: number }> {
    return [...this.db.exec<{ chunk_id: string; document_id: number }>(
      `SELECT v.chunk_id, v.document_id FROM vector_chunks v
       LEFT JOIN document_vector_state s ON s.document_id = v.document_id
       WHERE s.document_id IS NULL OR v.content_sha256 IS NOT s.active_content_sha256
       LIMIT ?`,
      Math.max(1, Math.floor(limit)),
    )].map(row => ({ chunkId: row.chunk_id, documentId: Number(row.document_id) }));
  }

  /** Removes ledger rows once their vectors are gone from Vectorize. */
  forgetChunks(chunkIds: string[]): void {
    for (const chunkId of chunkIds) this.db.exec("DELETE FROM vector_chunks WHERE chunk_id = ?", chunkId);
  }

  /** Forgets a document entirely, after its vectors are gone. The state row goes last, as the witness. */
  forgetDocument(documentId: number): void {
    this.db.exec("DELETE FROM vector_chunks WHERE document_id = ?", documentId);
    this.db.exec("DELETE FROM document_vector_state WHERE document_id = ?", documentId);
  }

  // ---------------------------------------------------------------------------------------------
  // Reading: the acceptance rule.
  // ---------------------------------------------------------------------------------------------

  /**
   * Turns retrieved chunk ids into servable hits.
   *
   * This is the acceptance rule, and every clause is load-bearing:
   *
   * - the ledger row must exist, which is the only way a chunk id becomes text at all;
   * - `status = 'ready'` — the active revision was published completely;
   * - `v.content_sha256 = s.active_content_sha256` — the row belongs to the revision that is published,
   *   not to a superseded one whose vectors are still in Vectorize waiting to be collected;
   * - `s.active_content_sha256 = d.content_sha256` — the note index has reached the same revision, so a
   *   hit can never describe text the rest of the Vault does not know about;
   * - the ledger count equals the recorded chunk count — the identity columns are a claim, and this
   *   makes the claim checkable rather than trusted. A short ledger refuses every hit instead of
   *   returning a partial answer.
   *
   * A path filter is applied here rather than in Vectorize, so the index carries no metadata that could
   * disagree with SQLite.
   */
  acceptHits(chunkIds: string[], prefix: string, revision: { chunkerVersion: number; embeddingModel: string; vectorVersion: number }): AcceptedHit[] {
    if (chunkIds.length === 0) return [];
    const marks = chunkIds.map(() => "?").join(",");
    const rows = [...this.db.exec<{
      chunk_id: string; document_id: number; ordinal: number; heading: string; text: string;
      key: string; title: string | null; modified: string | null; size: number | null;
    }>(
      `SELECT v.chunk_id, v.document_id, v.ordinal, v.heading, v.text, d.key, d.title, d.modified, d.size
       FROM vector_chunks v
       JOIN document_vector_state s ON s.document_id = v.document_id
       JOIN documents d ON d.id = v.document_id
       WHERE v.chunk_id IN (${marks})
         AND s.status = 'ready'
         AND v.content_sha256 = s.active_content_sha256
         AND s.active_content_sha256 = d.content_sha256
         AND s.active_chunker_version = ? AND s.active_embedding_model = ? AND s.active_vector_version = ?
         AND s.active_chunk_count = (SELECT COUNT(*) FROM vector_chunks c WHERE c.document_id = v.document_id AND c.content_sha256 = s.active_content_sha256)
         AND d.key LIKE ?`,
      ...chunkIds, revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion, `${prefix}%`,
    )];
    return rows.map(row => ({
      chunkId: row.chunk_id,
      documentId: Number(row.document_id),
      key: row.key,
      title: row.title,
      modified: row.modified,
      size: row.size === null ? null : Number(row.size),
      ordinal: Number(row.ordinal),
      heading: row.heading,
      text: row.text,
    }));
  }

  health(revision: { chunkerVersion: number; embeddingModel: string; vectorVersion: number }): VectorHealth {
    const row = this.first<{ tracked: number; ready: number; pending: number; outdated: number; failed: number }>(
      `SELECT COUNT(*) tracked,
              SUM(CASE WHEN status = 'ready' AND active_chunker_version = ? AND active_embedding_model = ? AND active_vector_version = ? THEN 1 ELSE 0 END) ready,
              SUM(CASE WHEN status <> 'ready' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status = 'ready' AND (active_chunker_version IS NOT ? OR active_embedding_model IS NOT ? OR active_vector_version IS NOT ?) THEN 1 ELSE 0 END) outdated,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) failed
       FROM document_vector_state`,
      revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion,
      revision.chunkerVersion, revision.embeddingModel, revision.vectorVersion,
    );
    const ledger = this.first<{ count: number }>("SELECT COUNT(*) count FROM vector_chunks");
    const error = this.first<{ last_error: string }>("SELECT last_error FROM document_vector_state WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
    return {
      tracked: Number(row?.tracked ?? 0),
      ready: Number(row?.ready ?? 0),
      pending: Number(row?.pending ?? 0),
      outdated: Number(row?.outdated ?? 0),
      ledgerChunks: Number(ledger?.count ?? 0),
      failed: Number(row?.failed ?? 0),
      lastError: error?.last_error ?? null,
    };
  }

  /** Test-only: the vector layer's own state, cleared. */
  clear(): void {
    this.db.exec("DELETE FROM pending_vector; DELETE FROM document_vector_state; DELETE FROM vector_chunks;");
  }
}

export type AcceptedHit = {
  chunkId: string;
  documentId: number;
  key: string;
  title: string | null;
  modified: string | null;
  size: number | null;
  ordinal: number;
  heading: string;
  text: string;
};

/** `SqlStorage.exec` reports how many rows it wrote through its cursor; a raw driver may not. */
function writtenBy(cursor: unknown): number {
  if (typeof (cursor as { rowsWritten?: unknown })?.rowsWritten === "number") return (cursor as { rowsWritten: number }).rowsWritten;
  return [...(cursor as Iterable<unknown>)].length;
}
