import { applyIntent, type IndexAction, type IndexIntent, type IndexIntentSpec } from "./intents";
import type { DueIndexIntent, IndexClaim, MutationStore, PendingIndexSummary, RecordMutationResult } from "../mutation/store";
import { isMutationSource, type BroadcastState, type JournalEntry, type MutationEvent, type MutationRecord, type MutationSource } from "../mutation/types";

/**
 * The narrowest slice of Cloudflare's Durable Object SQLite surface this module needs. Keeping the
 * dependency this small is what lets the journal's SQL be exercised directly in tests.
 */
export type SqlDatabase = {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
};

/**
 * The Mutation Journal and the materialised index dirty set.
 *
 * They share one SQLite instance on purpose: `record()` writes the fact and every intent it implies
 * inside one transaction, so a crash can never leave a recorded mutation whose index debt was lost.
 * The two tables stay strictly different things — one is an append-only fact log, the other is
 * "what work is still owed" — and nothing here treats either as a queue of the other.
 */
export const MUTATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mutation_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    op TEXT NOT NULL,
    path TEXT NOT NULL,
    from_path TEXT,
    etag TEXT,
    size INTEGER,
    committed_at INTEGER NOT NULL,
    broadcast_state TEXT NOT NULL DEFAULT 'pending',
    broadcast_attempts INTEGER NOT NULL DEFAULT 0,
    broadcast_last_error TEXT,
    gateway_generation TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mutation_journal_broadcast ON mutation_journal(broadcast_state, seq);
  CREATE TABLE IF NOT EXISTS pending_index (
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
  CREATE INDEX IF NOT EXISTS pending_index_due ON pending_index(not_before, updated_at);
`;

type JournalRow = {
  seq: number;
  mutation_id: string;
  source: string;
  op: string;
  path: string;
  from_path: string | null;
  etag: string | null;
  size: number | null;
  committed_at: number;
  broadcast_state: string;
  broadcast_attempts: number;
  broadcast_last_error: string | null;
  gateway_generation: string | null;
};

type PendingRow = {
  path: string;
  action: string;
  target_etag: string | null;
  source: string;
  not_before: number;
  first_dirty_at: number;
  updated_at: number;
  attempts: number;
  last_claim_at: number | null;
  last_error: string | null;
};

function source(value: string): MutationSource {
  return isMutationSource(value) ? value : "system";
}

function recordFrom(row: JournalRow): JournalEntry {
  const base = { id: row.mutation_id, seq: row.seq, source: source(row.source), committedAt: row.committed_at };
  const event: MutationRecord = row.op === "put"
    ? { ...base, op: "put", path: row.path, etag: row.etag ?? "", size: row.size ?? 0 }
    : row.op === "rename"
      ? { ...base, op: "rename", from: row.from_path ?? row.path, path: row.path, ...(row.etag ? { etag: row.etag } : {}), ...(row.size === null ? {} : { size: row.size }) }
      : { ...base, op: "delete", path: row.path };
  return {
    ...event,
    broadcastState: row.broadcast_state === "published" ? "published" : "pending" as BroadcastState,
    broadcastAttempts: row.broadcast_attempts,
    broadcastLastError: row.broadcast_last_error,
    gatewayGeneration: row.gateway_generation,
  };
}

function intentFrom(row: PendingRow): IndexIntent {
  return {
    path: row.path,
    action: row.action === "remove" ? "remove" : "upsert",
    targetEtag: row.target_etag,
    source: source(row.source),
    notBefore: row.not_before,
    firstDirtyAt: row.first_dirty_at,
    updatedAt: row.updated_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export class SqlMutationStore implements MutationStore {
  constructor(private readonly db: SqlDatabase) {
    for (const statement of MUTATION_SCHEMA.split(";")) if (statement.trim()) this.db.exec(statement);
  }

  private first<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): T | undefined {
    return [...this.db.exec<T>(query, ...bindings)][0];
  }

  findByMutationId(mutationId: string): JournalEntry | null {
    const row = this.first<JournalRow>("SELECT * FROM mutation_journal WHERE mutation_id = ?", mutationId);
    return row ? recordFrom(row) : null;
  }

  /**
   * Idempotent by `mutation_id`, and transactional across both tables.
   *
   * The unique index is the real guard, not the preceding read: two concurrent reports of the same
   * id cannot both observe "absent" and both insert.
   */
  recordWithinTransaction(event: MutationEvent, intents: IndexIntentSpec[]): RecordMutationResult {
    const existing = this.findByMutationId(event.id);
    if (existing) return { inserted: false, seq: existing.seq, entry: existing };
    const createdAt = Date.now();
    this.db.exec(
      "INSERT INTO mutation_journal (mutation_id, source, op, path, from_path, etag, size, committed_at, broadcast_state, broadcast_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
      event.id,
      event.source,
      event.op,
      event.path,
      event.op === "rename" ? event.from : null,
      event.op === "put" ? event.etag : event.op === "rename" ? event.etag ?? null : null,
      event.op === "put" ? event.size : event.op === "rename" ? event.size ?? null : null,
      event.committedAt,
      createdAt,
    );
    for (const spec of intents) this.upsertIntent(spec, event.source);
    const entry = this.findByMutationId(event.id)!;
    return { inserted: true, seq: entry.seq, entry };
  }

  /**
   * Coalescing in SQL: the row keeps the newest action/etag and the furthest-out `not_before`.
   *
   * `updated_at` is server time, not `committedAt`, because it is the ordering witness for the
   * compare-and-set guards below: a completing worker must be able to tell "nothing has touched this
   * row since I claimed it" without trusting a caller-supplied clock.
   */
  private upsertIntent(spec: IndexIntentSpec, source: MutationSource): void {
    const now = Date.now();
    this.db.exec(
      `INSERT INTO pending_index (path, action, target_etag, source, not_before, first_dirty_at, updated_at, attempts, last_claim_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(path) DO UPDATE SET
         action = excluded.action,
         target_etag = excluded.target_etag,
         source = excluded.source,
         not_before = MAX(pending_index.not_before, excluded.not_before),
         updated_at = excluded.updated_at,
         attempts = 0,
         last_claim_at = NULL,
         last_error = NULL`,
      spec.path,
      spec.action,
      spec.action === "remove" ? null : spec.targetEtag,
      source,
      spec.notBefore,
      now,
      now,
    );
  }

  listPendingBroadcasts(limit: number): JournalEntry[] {
    return [...this.db.exec<JournalRow>(
      "SELECT * FROM mutation_journal WHERE broadcast_state = 'pending' ORDER BY seq LIMIT ?",
      Math.max(1, Math.floor(limit)),
    )].map(recordFrom);
  }

  markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): void {
    if (input.state === "published") {
      this.db.exec(
        "UPDATE mutation_journal SET broadcast_state = 'published', broadcast_attempts = broadcast_attempts + 1, broadcast_last_error = NULL, gateway_generation = COALESCE(gateway_generation, ?) WHERE mutation_id = ?",
        input.generation ?? null,
        input.mutationId,
      );
      return;
    }
    this.db.exec(
      "UPDATE mutation_journal SET broadcast_attempts = broadcast_attempts + 1, broadcast_last_error = ? WHERE mutation_id = ? AND broadcast_state = 'pending'",
      input.error ?? null,
      input.mutationId,
    );
  }

  pendingSummary(now: number): PendingIndexSummary {
    const row = this.first<{ due: number; upserts: number; removes: number; earliest: number | null }>(
      `SELECT
         SUM(CASE WHEN not_before <= ? THEN 1 ELSE 0 END) due,
         SUM(CASE WHEN action = 'upsert' THEN 1 ELSE 0 END) upserts,
         SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) removes,
         MIN(not_before) earliest
       FROM pending_index`,
      now,
    );
    return { due: Number(row?.due ?? 0), upserts: Number(row?.upserts ?? 0), removes: Number(row?.removes ?? 0), earliestNotBefore: row?.earliest ?? null };
  }

  listDueIndexPaths(now: number, limit: number): DueIndexIntent[] {
    return [...this.db.exec<PendingRow>(
      "SELECT * FROM pending_index WHERE not_before <= ? ORDER BY updated_at, path LIMIT ?",
      now,
      Math.max(1, Math.floor(limit)),
    )].map(row => ({ path: row.path, action: row.action === "remove" ? "remove" : "upsert", targetEtag: row.target_etag }));
  }

  /**
   * Claims one due intent, but only while it is still exactly the intent the caller saw.
   *
   * The `changes()` count is the whole guard: a mutation that arrived between reading and claiming
   * has already changed one of the three compared columns, so this returns no claim instead of
   * letting a worker index a revision that is no longer owed.
   */
  claimPendingIndex(input: { path: string; etag: string | null; action: IndexAction; now: number }): IndexClaim {
    const changes = this.db.exec(
      `UPDATE pending_index SET attempts = attempts + 1, last_claim_at = ?
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ? AND not_before <= ?`,
      input.now,
      input.path,
      input.action,
      input.etag ?? "",
      input.now,
    );
    if (countChanges(changes) === 0) {
      return this.first<PendingRow>("SELECT * FROM pending_index WHERE path = ?", input.path) ? { status: "superseded" } : { status: "missing" };
    }
    const row = this.first<PendingRow>("SELECT * FROM pending_index WHERE path = ?", input.path)!;
    return { status: "claimed", intent: intentFrom(row), attempts: row.attempts };
  }

  /**
   * Compare-and-set delete.
   *
   * Two independent guards, both required: the `(action, target_etag)` pair must still be the one
   * this worker claimed, **and** the row must not have been rewritten since the claim. `false` means
   * a newer intent exists and must be left alone — deleting it would silently drop index work.
   */
  completeIndex(input: { path: string; etag: string | null; action: IndexAction }): boolean {
    const changes = this.db.exec(
      `DELETE FROM pending_index
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ?
         AND (last_claim_at IS NULL OR updated_at <= last_claim_at)`,
      input.path,
      input.action,
      input.etag ?? "",
    );
    return countChanges(changes) > 0;
  }

  failIndex(input: { path: string; etag: string | null; action: IndexAction; error: string; notBefore: number }): void {
    this.db.exec(
      `UPDATE pending_index SET last_error = ?, last_claim_at = NULL, not_before = MAX(not_before, ?)
       WHERE path = ? AND action = ? AND IFNULL(target_etag, '') = ?`,
      input.error.slice(0, 200),
      input.notBefore,
      input.path,
      input.action,
      input.etag ?? "",
    );
  }

  /**
   * One SQLite transaction for the whole `recordMutation()` write.
   *
   * The Durable Object supplies it through `ctx.storage.transactionSync`, and
   * `recordWithinTransaction` is what runs inside that block. If an intent upsert fails, the journal
   * insert rolls back with it and the caller sees the failure — a mutation is never "half recorded".
   */
  record(event: MutationEvent, intents: IndexIntentSpec[]): RecordMutationResult {
    return this.recordWithinTransaction(event, intents);
  }
}

/** `SqlStorage.exec` reports the mutation count through its cursor; a raw driver may not. */
function countChanges(changes: unknown): number {
  const cursor = changes as { rowsWritten?: number } | Iterable<unknown> | undefined;
  if (cursor && typeof (cursor as { rowsWritten?: number }).rowsWritten === "number") return (cursor as { rowsWritten: number }).rowsWritten;
  return [...(cursor as Iterable<unknown>)].length;
}
