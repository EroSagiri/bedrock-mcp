import type { MutationRecorder } from "./recorder";
import type { MutationJournal } from "./store";
import { isMutationEvent, isMutationSource, type MutationEvent, type MutationSource } from "./types";

/**
 * A mutation whose R2 write the **Vault itself** performed, submitted for recording only.
 *
 * This is the repair half of `recordMutation()`: when a committed write's journal record could not be
 * created, the writer already holds everything needed to record it — id, source, op, path, and the
 * revision R2 returned — so it can be retried without touching R2 again. That distinction is the
 * whole point: a repair must never re-apply a write.
 */
export type CommittedMutationInput = {
  id: string;
  source: MutationSource;
  op: "put" | "delete" | "rename";
  path: string;
  etag?: string;
  size?: number;
  from?: string;
  committedAt: number;
};

/** Sources that may be recorded as already-committed: the Vault's own authoritative writers. */
export const COMMITTED_SOURCES: readonly MutationSource[] = ["mcp", "web", "system"];

/**
 * Accepts only what can be journalled as a fact about an R2 write that already happened.
 *
 * It is the same bounded shape the ingress accepts, with one difference that matters: a `rename`
 * must carry its `from`, because there is no R2 operation to reconstruct it from — this entry point
 * never reads or writes R2.
 */
export function parseCommittedMutation(value: unknown): MutationEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isMutationSource(input.source) || !COMMITTED_SOURCES.includes(input.source)) return null;
  if (typeof input.id !== "string" || input.id.length === 0 || input.id.length > 128) return null;
  if (typeof input.committedAt !== "number" || !Number.isFinite(input.committedAt) || input.committedAt < 0) return null;
  const candidate: Record<string, unknown> = { ...input, committedAt: Math.floor(input.committedAt) };
  return isMutationEvent(candidate) ? candidate : null;
}

/** How many times a repair retries, and how long it waits between attempts. */
export const REPAIR_ATTEMPTS = 3;
export const REPAIR_BACKOFF_MS = 200;

/**
 * Retries recording a committed mutation until it lands, or until the attempts are exhausted.
 *
 * Every attempt reuses the same `mutationId`, so it is safe by construction: the journal's UNIQUE
 * constraint turns a duplicate into "already recorded" instead of a second fact. Nothing here reads
 * or writes R2, and nothing here can change the outcome the writer already received.
 */
export async function recordCommittedMutationUntilRecorded(
  dependencies: { journal: MutationJournal; recorder: MutationRecorder; sleep?(ms: number): Promise<void> },
  event: MutationEvent,
): Promise<{ recorded: boolean; seq?: number; attempts: number }> {
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  // Already recorded: report the existing sequence rather than a second fact. This is the case a
  // redelivery after a lost response lands in, and it must be indistinguishable from success.
  const existing = await dependencies.journal.findByMutationId(event.id);
  if (existing) return { recorded: true, seq: existing.seq, attempts: 0 };
  let lastError: unknown;
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    try {
      const recorded = await dependencies.recorder.record(event);
      return { recorded: true, seq: recorded.seq, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < REPAIR_ATTEMPTS) await sleep(REPAIR_BACKOFF_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("mutation repair failed");
}
