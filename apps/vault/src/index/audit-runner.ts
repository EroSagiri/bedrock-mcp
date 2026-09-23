import { drainDueIndex } from "./scheduler";
import type { MutationJournal } from "../mutation/store";

/** The Durable Object surface this runner needs; declared structurally so it stays testable. */
export type AuditIndex = {
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: true; indexedEtag: string | null; status: string } | { applied: false; error: string }>;
  startIndexAudit(now: number): Promise<{ auditId: number; startedAt: number; status: string }>;
  runIndexAuditPage(): Promise<{ audit: { auditId: number; scanned: number; dirty: number; status: string }; enqueued: string[]; removed: string[]; done: boolean } | null>;
  pendingSummary(now: number): Promise<{ due: number; upserts: number; removes: number; earliestNotBefore: number | null }>;
};

export type AuditRun = {
  auditId: number;
  pages: number;
  scanned: number;
  enqueued: number;
  removed: number;
  applied: number;
  pendingLeft: number;
};

/**
 * How many pages one run may walk.
 *
 * An R2 list page is large enough that a vault this size is a handful of pages, so this bounds a
 * pathological case (a wrong cursor) rather than normal work.
 */
export const AUDIT_PAGE_LIMIT = 200;
/**
 * How many documents one page may get indexed behind it.
 *
 * This is the throttle that matters, and it is deliberately much larger than the per-request drain: an
 * audit's whole purpose is to clear a backlog, and a first-time backfill that only advances eight
 * documents per page would take dozens of runs. A live write still takes precedence because it is
 * enqueued with `not_before = now` and the drain is oldest-first.
 */
export const AUDIT_DRAIN_PER_PAGE = 32;

/**
 * Runs a revision audit and drives the indexer over what it enqueued.
 *
 * The audit itself only lists, diffs, and enqueues — it never writes the index. This runner is the
 * only place permitted to *kick* the indexer, and it does so through the same `applyIndexIntent`
 * every other path uses, so an audit can never become a second writer with its own rules.
 */
export async function runIndexAudit(
  dependencies: { journal: MutationJournal; index: AuditIndex; now?: number },
): Promise<AuditRun> {
  const now = dependencies.now ?? Date.now();
  const started = await dependencies.index.startIndexAudit(now);
  const run: AuditRun = { auditId: started.auditId, pages: 0, scanned: 0, enqueued: 0, removed: 0, applied: 0, pendingLeft: 0 };

  for (let page = 0; page < AUDIT_PAGE_LIMIT; page++) {
    const result = await dependencies.index.runIndexAuditPage();
    if (!result) break;
    run.pages++;
    run.scanned = result.audit.scanned;
    run.enqueued += result.enqueued.length;
    run.removed += result.removed.length;

    // Drain what the page just queued before listing the next one: a live write must never wait behind
    // a full-vault walk, and the pending set stays small even for a first-time backfill.
    const drained = await drainDueIndex({
      journal: dependencies.journal,
      indexer: { apply: intent => dependencies.index.applyIndexIntent(intent) },
    }, { limit: AUDIT_DRAIN_PER_PAGE });
    run.applied += drained.applied;
    if (result.done) break;
  }

  const summary = await dependencies.index.pendingSummary(Date.now());
  run.pendingLeft = summary.upserts + summary.removes;
  return run;
}
