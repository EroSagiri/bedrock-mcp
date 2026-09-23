import { mutationLog, pathDigest } from "../mutation/ids";
import type { DueVectorIntent, VectorClaim, VectorQueueSummary } from "./store";
import type { VectorApplyResult } from "./publish";

/**
 * Per-drain ceilings. Embedding is the most expensive thing the Vault does, so the batch is smaller than
 * the note index's: a request must not turn into a minute of Workers AI calls.
 */
export const VECTOR_DRAIN_BATCH_LIMIT = 4;
export const VECTOR_GC_BATCH_LIMIT = 64;

/** A real failure (Vectorize down, a malformed response) waits, rather than retrying on every request. */
export const VECTOR_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/**
 * A deferral is not a failure: the note index has not published the document yet, or the file changed
 * while its vectors were being computed. Both resolve within a drain or two, so they retry soon.
 */
export const VECTOR_DEFER_BACKOFF_MS = 15 * 1000;

export type VectorIndexer = {
  apply(intent: { path: string; action: "upsert" | "remove" }): Promise<VectorApplyResult>;
  collectGarbage(limit: number): Promise<number>;
};

/** The dirty set as the scheduler sees it; the Durable Object supplies the real one. */
export type VectorQueue = {
  pendingVectorSummary(now: number): Promise<VectorQueueSummary>;
  listDueVectorPaths(now: number, limit: number): Promise<DueVectorIntent[]>;
  claimPendingVector(input: { path: string; etag: string | null; action: "upsert" | "remove"; now: number }): Promise<VectorClaim>;
  completeVector(input: { path: string; etag: string | null; action: "upsert" | "remove" }): Promise<boolean>;
  failVector(input: { path: string; etag: string | null; action: "upsert" | "remove"; error: string; notBefore: number }): Promise<void>;
};

export type VectorDrainOutcome = {
  due: number;
  scanned: number;
  published: number;
  removed: number;
  noops: number;
  deferred: number;
  failed: number;
  superseded: number;
  collected: number;
};

export type VectorSchedulerDependencies = {
  queue: VectorQueue;
  indexer: VectorIndexer;
  now?: () => number;
  onSummary?(summary: VectorQueueSummary): void;
};

/**
 * The vector drain: `pending_vector` → Vectorize.
 *
 * It is the note index's scheduler with one addition. Claims are compare-and-set for the same reason —
 * a path that was re-dirtied while its vectors were being computed must not have its newer intent
 * deleted — and garbage collection runs once per drain, after the publishes, because a superseded
 * revision only becomes collectable once the publish that superseded it has committed.
 */
export async function drainDueVector(
  { queue, indexer, now = Date.now, onSummary }: VectorSchedulerDependencies,
  options: { limit?: number; gcLimit?: number } = {},
): Promise<VectorDrainOutcome> {
  const at = now();
  const summary = await queue.pendingVectorSummary(at);
  onSummary?.(summary);
  const outcome: VectorDrainOutcome = { due: summary.due, scanned: 0, published: 0, removed: 0, noops: 0, deferred: 0, failed: 0, superseded: 0, collected: 0 };
  if (summary.due > 0) {
    // Oldest work first, so a hot path cannot starve a note that went dirty long ago.
    const due = await queue.listDueVectorPaths(at, options.limit ?? VECTOR_DRAIN_BATCH_LIMIT);
    for (const intent of due) {
      outcome.scanned++;
      const result = await applyClaim(queue, indexer, now, intent);
      if (result === "published") outcome.published++;
      else if (result === "removed") outcome.removed++;
      else if (result === "noop") outcome.noops++;
      else if (result === "deferred") outcome.deferred++;
      else if (result === "superseded") outcome.superseded++;
      else outcome.failed++;
    }
  }
  outcome.collected = await indexer.collectGarbage(options.gcLimit ?? VECTOR_GC_BATCH_LIMIT);
  return outcome;
}

async function applyClaim(
  queue: VectorQueue,
  indexer: VectorIndexer,
  now: () => number,
  intent: DueVectorIntent,
): Promise<"published" | "removed" | "noop" | "deferred" | "failed" | "superseded"> {
  const claim = await queue.claimPendingVector({ path: intent.path, etag: intent.targetEtag, action: intent.action, now: now() });
  if (claim.status !== "claimed") return "superseded";
  const digest = await pathDigest(intent.path);
  try {
    const result = await indexer.apply({ path: intent.path, action: intent.action });
    if (!result.applied) {
      const backoff = result.deferred ? VECTOR_DEFER_BACKOFF_MS : VECTOR_RETRY_BACKOFF_MS;
      await queue.failVector({ path: intent.path, etag: intent.targetEtag, action: intent.action, error: result.error, notBefore: now() + backoff });
      mutationLog(result.deferred ? "vector intent deferred" : "vector intent failed", { pathDigest: digest, action: intent.action, attempts: claim.attempts });
      return result.deferred ? "deferred" : "failed";
    }
    // Compare-and-set delete: an intent that arrived while this ran survives untouched.
    const deleted = await queue.completeVector({ path: intent.path, etag: intent.targetEtag, action: intent.action });
    if (!deleted) {
      mutationLog("vector intent superseded", { pathDigest: digest, action: intent.action });
      return "superseded";
    }
    mutationLog("vector intent completed", { pathDigest: digest, action: intent.action, status: result.status, attempts: claim.attempts, chunks: result.status === "empty" ? 0 : result.chunks });
    return result.status === "removed" ? "removed" : result.status === "noop" ? "noop" : "published";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await queue.failVector({ path: intent.path, etag: intent.targetEtag, action: intent.action, error: message.slice(0, 200), notBefore: now() + VECTOR_RETRY_BACKOFF_MS });
    mutationLog("vector intent failed", { pathDigest: digest, action: intent.action });
    return "failed";
  }
}
