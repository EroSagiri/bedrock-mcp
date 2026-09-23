import { mutationLog, pathDigest } from "../mutation/ids";
import type { MutationJournal, PendingIndexSummary } from "../mutation/store";
import type { IndexIntent } from "./intents";

/** Conservative per-drain ceiling: this runs inside a request or a cron wake-up, not a Queue. */
export const INDEX_DRAIN_BATCH_LIMIT = 16;

/** A failing intent is retried, but with a growing pause instead of once per request. */
export const INDEX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** The index side of the boundary: given an intent, make the note index agree with R2. */
export type IndexApplyResult = { applied: true; indexedEtag: string | null } | { applied: false; error: string };

export type NoteIndexer = {
  /**
   * `remove` must be idempotent. `upsert` must index whatever R2 currently holds — never the etag in
   * the intent — and report which revision it actually indexed.
   */
  apply(intent: Pick<IndexIntent, "path" | "action">): Promise<IndexApplyResult>;
};

export type IndexDrainOutcome = {
  due: number;
  scanned: number;
  applied: number;
  failed: number;
  superseded: number;
  deferred: number;
};

export type IndexSchedulerDependencies = {
  journal: MutationJournal;
  indexer: NoteIndexer;
  now?: () => number;
  /** Surfaces what is still owed even when nothing is due yet. */
  onSummary?(summary: PendingIndexSummary): void;
};

/**
 * The Index Scheduler: Mutation Journal → `pending_index` → the note index.
 *
 * It is not a FIFO consumer. Each due path is *claimed* against its exact `(action, target_etag)`
 * pair; if a newer mutation landed in the meantime the claim is superseded and the newer intent is
 * left alone. On success the row is deleted with the same comparison (see `completeIndex`), so a
 * completion can never erase work that arrived while it was running.
 */
export async function drainDueIndex(
  { journal, indexer, now = Date.now, onSummary }: IndexSchedulerDependencies,
  options: { limit?: number } = {},
): Promise<IndexDrainOutcome> {
  const at = now();
  const summary = await journal.pendingSummary(at);
  onSummary?.(summary);
  const outcome: IndexDrainOutcome = { due: summary.due, scanned: 0, applied: 0, failed: 0, superseded: 0, deferred: 0 };
  if (summary.due === 0) return outcome;

  // Oldest work first, so a hot path cannot starve a note that went dirty long ago.
  const due = await journal.listDueIndexPaths(at, options.limit ?? INDEX_DRAIN_BATCH_LIMIT);
  outcome.deferred = Math.max(0, summary.due - due.length);
  for (const intent of due) {
    outcome.scanned++;
    const result = await applyClaim(journal, indexer, now, intent);
    if (result === "applied") outcome.applied++;
    else if (result === "superseded") outcome.superseded++;
    else outcome.failed++;
  }
  return outcome;
}

async function applyClaim(
  journal: MutationJournal,
  indexer: NoteIndexer,
  now: () => number,
  intent: Pick<IndexIntent, "path" | "action" | "targetEtag">,
): Promise<"applied" | "failed" | "superseded"> {
  const claim = await journal.claimPendingIndex({ path: intent.path, etag: intent.targetEtag, action: intent.action, now: now() });
  if (claim.status !== "claimed") return "superseded";
  const digest = await pathDigest(intent.path);
  const retryAt = now() + INDEX_RETRY_BACKOFF_MS;
  try {
    const result = await indexer.apply({ path: intent.path, action: intent.action });
    if (!result.applied) {
      await journal.failIndex({ path: intent.path, etag: intent.targetEtag, action: intent.action, error: result.error, notBefore: retryAt });
      mutationLog("index intent failed", { pathDigest: digest, action: intent.action, attempts: claim.attempts });
      return "failed";
    }
    // Compare-and-set delete: a newer intent for this path survives untouched.
    const deleted = await journal.completeIndex({ path: intent.path, etag: intent.targetEtag, action: intent.action });
    if (!deleted) {
      mutationLog("index intent superseded", { pathDigest: digest, action: intent.action });
      return "superseded";
    }
    mutationLog("index intent completed", { pathDigest: digest, action: intent.action, attempts: claim.attempts });
    return "applied";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await journal.failIndex({ path: intent.path, etag: intent.targetEtag, action: intent.action, error: message.slice(0, 200), notBefore: retryAt });
    mutationLog("index intent failed", { pathDigest: digest, action: intent.action });
    return "failed";
  }
}
