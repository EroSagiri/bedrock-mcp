/**
 * The revision audit: a paged walk of R2 compared against what the index believes.
 *
 * The audit **never writes the index**. It lists, diffs, and enqueues into `pending_index`, which is
 * the same queue the mutation journal feeds. That single-writer rule is what makes an audit and a live
 * write safe to run at the same time: the audit can be wrong about what is owed — it only produces a
 * hint to re-observe — while the indexer, which is the only writer, always reads R2's current revision
 * before publishing anything.
 *
 * The one thing the audit does own is **delete candidates**: a path the index holds that R2 no longer
 * lists. Two guards keep a false candidate from becoming a deletion, and the second one is the real
 * boundary:
 *
 * 1. only documents indexed before the walk started are considered (a document indexed *during* the
 *    walk may simply not have existed when its page was listed);
 * 2. the indexer re-observes R2 on a `remove` intent, so a candidate that still exists becomes an
 *    upsert instead of a deletion.
 */
export const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS index_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    cursor TEXT,
    status TEXT NOT NULL,
    scanned INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS index_audit_status ON index_audit(status);

  CREATE TABLE IF NOT EXISTS index_audit_seen (
    audit_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (audit_id, path)
  );
`;

export type AuditStatus = "running" | "completed" | "abandoned";

export type IndexAudit = {
  auditId: number;
  startedAt: number;
  cursor: string | null;
  status: AuditStatus;
  scanned: number;
  dirty: number;
  completedAt: number | null;
};

export type AuditPage = {
  audit: IndexAudit;
  /** Paths this page found changed or new, and paths it believes are gone. */
  enqueued: number;
  removed: number;
  done: boolean;
};
