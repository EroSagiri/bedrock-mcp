import { drainDueIndex } from "./scheduler";
import { drainDueVector, type VectorIndexer, type VectorQueue } from "../vector/scheduler";
import type { MutationJournal } from "../mutation/store";

/** The Durable Object surface this runner needs; declared structurally so it stays testable. */
export type AuditIndex = {
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: true; indexedEtag: string | null; status: string } | { applied: false; error: string }>;
  startIndexAudit(now: number): Promise<{ auditId: number; startedAt: number; status: string }>;
  runIndexAuditPage(): Promise<{ audit: { auditId: number; scanned: number; dirty: number; status: string }; enqueued: string[]; removed: string[]; done: boolean } | null>;
  pendingSummary(now: number): Promise<{ due: number; upserts: number; removes: number; earliestNotBefore: number | null }>;
};

/**
 * The vector half of the audit.
 *
 * `sweep` is the part the note index has no equivalent of. A document whose *chunker* or *model* moved
 * on is stale even though R2 never changed and the note index is perfectly current, so the R2 walk alone
 * can never find it — the sweep asks the vector state directly, and it is the only thing that does.
 */
export type AuditVectors = {
  queue: VectorQueue;
  indexer: VectorIndexer;
  sweep(now: number): Promise<number>;
};

export type AuditRun = {
  auditId: number;
  pages: number;
  scanned: number;
  enqueued: number;
  removed: number;
  applied: number;
  pendingLeft: number;
  vectorsEnqueued: number;
  vectorsApplied: number;
  vectorsCollected: number;
  vectorsPendingLeft: number;
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
 * The vector throttle is much smaller than the note index's, because each document costs a Workers AI
 * call: a first-time backfill of a small vault is one audit, and a large one is a few.
 */
export const AUDIT_VECTOR_DRAIN_PER_PAGE = 8;

/**
 * Runs a revision audit and drives the indexer over what it enqueued.
 *
 * The audit itself only lists, diffs, and enqueues — it never writes the index. This runner is the
 * only place permitted to *kick* the indexer, and it does so through the same `applyIndexIntent`
 * every other path uses, so an audit can never become a second writer with its own rules.
 */
export async function runIndexAudit(
  dependencies: { journal: MutationJournal; index: AuditIndex; vectors?: AuditVectors; now?: number },
): Promise<AuditRun> {
  const now = dependencies.now ?? Date.now();
  const started = await dependencies.index.startIndexAudit(now);
  const run: AuditRun = {
    auditId: started.auditId, pages: 0, scanned: 0, enqueued: 0, removed: 0, applied: 0, pendingLeft: 0,
    vectorsEnqueued: 0, vectorsApplied: 0, vectorsCollected: 0, vectorsPendingLeft: 0,
  };
  const vectors = dependencies.vectors;

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
    if (vectors) {
      const vectorDrain = await drainVectors(vectors, AUDIT_VECTOR_DRAIN_PER_PAGE);
      run.vectorsApplied += vectorDrain.applied;
      run.vectorsCollected += vectorDrain.collected;
    }
    if (result.done) break;
  }

  if (vectors) {
    // The walk cannot see a changed chunker or model; the sweep can. It runs after the walk so it sees
    // the note index at its final state for this audit, and its work is drained immediately.
    run.vectorsEnqueued = await vectors.sweep(Date.now());
    const finalDrain = await drainVectors(vectors, AUDIT_VECTOR_DRAIN_PER_PAGE * 4);
    run.vectorsApplied += finalDrain.applied;
    run.vectorsCollected += finalDrain.collected;
    run.vectorsPendingLeft = (await vectors.queue.pendingVectorSummary(Date.now())).upserts;
  }

  const summary = await dependencies.index.pendingSummary(Date.now());
  run.pendingLeft = summary.upserts + summary.removes;
  return run;
}

async function drainVectors(vectors: AuditVectors, limit: number): Promise<{ applied: number; collected: number }> {
  const drained = await drainDueVector({ queue: vectors.queue, indexer: vectors.indexer }, { limit });
  return { applied: drained.published + drained.removed + drained.noops, collected: drained.collected };
}
