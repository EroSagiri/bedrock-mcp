import type { IndexIntent, IndexIntentSpec, IndexAction } from "../index/intents";
import type { JournalEntry, MutationEvent } from "./types";

/**
 * The persistence port for the Mutation Journal and the materialised index dirty set.
 *
 * The concrete implementation is Vault-internal (the `VaultIndex` Durable Object's SQLite), so this
 * port exists so that the consumers — the Sync Publisher and the Index Scheduler — can be written
 * and tested against an explicit, small contract instead of against storage.
 */
export type RecordMutationResult = {
  /** `false` means the id was already in the journal and nothing new was written. */
  inserted: boolean;
  seq: number;
  entry: JournalEntry;
};

/** The outcome of a claim attempt on one due index intent. */
export type IndexClaim =
  | { status: "claimed"; intent: IndexIntent; attempts: number }
  | { status: "superseded" }
  | { status: "missing" }
  | { status: "skipped"; reason: "claimed-elsewhere" };

export type PendingIndexSummary = {
  due: number;
  upserts: number;
  removes: number;
  earliestNotBefore: number | null;
};

/** The minimal identity of a due intent. The claim re-checks all three fields. */
export type DueIndexIntent = Pick<IndexIntent, "path" | "action" | "targetEtag">;

/**
 * One atomic write: the journal fact and every index intent it implies land together, or neither
 * does. `intents` is computed by the caller (`indexIntentsFor`) so this port performs no policy.
 */
export type MutationStore = {
  record(event: MutationEvent, intents: IndexIntentSpec[]): RecordMutationResult;
  /** The persisted entry for an idempotency key, or `null`. Never throws for a missing key. */
  findByMutationId(mutationId: string): JournalEntry | null;
  listPendingBroadcasts(limit: number): JournalEntry[];
  markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): void;
  pendingSummary(now: number): PendingIndexSummary;
  /** Oldest-first, bounded. Every returned intent must still be claimable. */
  listDueIndexPaths(now: number, limit: number): DueIndexIntent[];
  claimPendingIndex(input: { path: string; etag: string | null; action: IndexAction; now: number }): IndexClaim;
  completeIndex(input: { path: string; etag: string | null; action: IndexAction }): boolean;
  /** Records a failure and defers the intent until `notBefore`. Never touches a superseded row. */
  failIndex(input: { path: string; etag: string | null; action: IndexAction; error: string; notBefore: number }): void;
};

/**
 * The consumer-facing journal port.
 *
 * It is the same contract as `MutationStore`, made asynchronous because the durable implementation is
 * a Durable Object reached over RPC. `record()` owns the transaction (the journal fact and every
 * intent it implies commit together); the remaining operations are single statements. A consumer
 * depends on this port, never on the Durable Object, and never on storage.
 */
export type MutationJournal = {
  recordMutation(input: { event: MutationEvent; intents: IndexIntentSpec[] }): Promise<RecordMutationResult>;
  findByMutationId(mutationId: string): Promise<JournalEntry | null>;
  listPendingBroadcasts(limit: number): Promise<JournalEntry[]>;
  markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): Promise<void>;
  pendingSummary(now: number): Promise<PendingIndexSummary>;
  listDueIndexPaths(now: number, limit: number): Promise<DueIndexIntent[]>;
  claimPendingIndex(input: { path: string; etag: string | null; action: IndexAction; now: number }): Promise<IndexClaim>;
  completeIndex(input: { path: string; etag: string | null; action: IndexAction }): Promise<boolean>;
  failIndex(input: { path: string; etag: string | null; action: IndexAction; error: string; notBefore: number }): Promise<void>;
};

/** Adapts a synchronous store (tests, in-process use) to the consumer-facing port. */
export function journalFromStore(store: MutationStore): MutationJournal {
  return {
    async recordMutation({ event, intents }) { return store.record(event, intents); },
    async findByMutationId(mutationId) { return store.findByMutationId(mutationId); },
    async listPendingBroadcasts(limit) { return store.listPendingBroadcasts(limit); },
    async markBroadcast(input) { store.markBroadcast(input); },
    async pendingSummary(now) { return store.pendingSummary(now); },
    async listDueIndexPaths(now, limit) { return store.listDueIndexPaths(now, limit); },
    async claimPendingIndex(input) { return store.claimPendingIndex(input); },
    async completeIndex(input) { return store.completeIndex(input); },
    async failIndex(input) { store.failIndex(input); },
  };
}
