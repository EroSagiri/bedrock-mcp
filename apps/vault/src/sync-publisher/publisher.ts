import { mutationLog, pathDigest } from "../mutation/ids";
import type { MutationJournal } from "../mutation/store";
import type { JournalEntry } from "../mutation/types";
import { boundedError, type GatewayPublisher } from "./gateway-port";
/** Bounded so one outage cannot turn a single request into an unbounded fan-out. */
export const PUBLISH_BATCH_LIMIT = 8;

export type PublishOutcome = {
  attempted: number;
  published: number;
  failed: number;
  /** Entries that had already been delivered, and were therefore not sent again. */
  skipped: number;
};

export type SyncPublisherDependencies = {
  journal: MutationJournal;
  gateway: GatewayPublisher;
  /** Called after a successful delivery; the Vault uses it to drain due index work too. */
  onPublished?(entry: JournalEntry, generation: string): Promise<void> | void;
};

/**
 * The Sync Publisher: Mutation Journal → Sync Gateway.
 *
 * Outbox semantics, in one place:
 *
 * - A pending entry is attempted once per drain, then left pending. Nothing is dropped and nothing
 *   is retried in a tight loop.
 * - `broadcast_state = published` is the durability barrier. Once it is set, a later drain (or a
 *   retried request) never calls the gateway for that mutation again, so the generation cannot be
 *   minted twice for one fact. The stored `gateway_generation` is what a replay reports.
 * - A gateway failure never propagates to the writer: this function returns counts, it does not
 *   throw for a delivery problem.
 */
export async function drainSyncOutbox(
  { journal, gateway, onPublished }: SyncPublisherDependencies,
  options: { limit?: number } = {},
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { attempted: 0, published: 0, failed: 0, skipped: 0 };
  const pending = await journal.listPendingBroadcasts(options.limit ?? PUBLISH_BATCH_LIMIT);
  for (const entry of pending) {
    if (entry.gatewayGeneration !== null) {
      // A previous drain delivered it but the state update was lost. Reuse the generation.
      await journal.markBroadcast({ mutationId: entry.id, state: "published", generation: entry.gatewayGeneration });
      outcome.skipped++;
      continue;
    }
    const digest = await pathDigest(entry.path);
    const attempts = entry.broadcastAttempts + 1;
    mutationLog("mutation broadcast pending", { id: entry.id, seq: entry.seq, op: entry.op, pathDigest: digest, attempts });
    outcome.attempted++;
    let result: Awaited<ReturnType<GatewayPublisher["publish"]>>;
    try {
      result = await gateway.publish({ ...entry, mutationId: entry.id });
    } catch (error) {
      result = { ok: false, kind: "transport" as const };
      await journal.markBroadcast({ mutationId: entry.id, state: "pending", error: boundedError(error) });
      outcome.failed++;
      continue;
    }
    if (!result.ok) {
      await journal.markBroadcast({ mutationId: entry.id, state: "pending", error: result.kind });
      outcome.failed++;
      continue;
    }
    await journal.markBroadcast({ mutationId: entry.id, state: "published", generation: result.generation });
    outcome.published++;
    mutationLog("mutation broadcast published", { id: entry.id, seq: entry.seq, gatewayGeneration: result.generation });
    await onPublished?.(entry, result.generation);
  }
  return outcome;
}

/**
 * Attempts to deliver exactly one mutation.
 *
 * This is the path a fresh write takes: publish eagerly, but a failure is recorded as `pending` and
 * answered with `ok: false` — never as a write failure.
 *
 * The journal is re-read rather than trusting the caller's copy, because the caller's copy is
 * exactly what a retry after a lost response is stale about. A mutation that already has a
 * generation is not sent again, no matter how many times this is called.
 */
export async function publishMutation(
  { journal, gateway, onPublished }: SyncPublisherDependencies,
  mutationId: string,
): Promise<{ ok: boolean; generation?: string }> {
  const current = await journal.findByMutationId(mutationId);
  if (!current) return { ok: false };
  if (current.gatewayGeneration !== null) {
    await journal.markBroadcast({ mutationId, state: "published", generation: current.gatewayGeneration });
    return { ok: true, generation: current.gatewayGeneration };
  }
  const digest = await pathDigest(current.path);
  mutationLog("mutation broadcast pending", { id: current.id, seq: current.seq, op: current.op, pathDigest: digest });
  try {
    const result = await gateway.publish({ ...current, mutationId });
    if (!result.ok) {
      await journal.markBroadcast({ mutationId, state: "pending", error: result.kind });
      return { ok: false };
    }
    await journal.markBroadcast({ mutationId, state: "published", generation: result.generation });
    mutationLog("mutation broadcast published", { id: current.id, seq: current.seq, gatewayGeneration: result.generation });
    await onPublished?.(current, result.generation);
    return { ok: true, generation: result.generation };
  } catch (error) {
    await journal.markBroadcast({ mutationId, state: "pending", error: boundedError(error) });
    return { ok: false };
  }
}
