import { indexIntentsFor } from "../index/intents";
import { createMutationId, mutationLog, pathDigest } from "./ids";
import type { MutationJournal } from "./store";
import { isMutationEvent, type MutationEvent, type MutationSource } from "./types";

export type RecordMutationInput = {
  source: MutationSource;
  op: "put";
  path: string;
  etag: string;
  size: number;
} | {
  source: MutationSource;
  op: "delete";
  path: string;
} | {
  source: MutationSource;
  op: "rename";
  from: string;
  path: string;
  etag?: string;
  size?: number;
};

export type RecordedMutation = {
  id: string;
  seq: number;
  /** `true` when this call created the fact; `false` when the id was already journalled. */
  inserted: boolean;
  /** `true` when the caller-supplied id was reused, i.e. this was an idempotent retry. */
  duplicate: boolean;
};

export type MutationRecorderDependencies = {
  journal: MutationJournal;
  now?: () => number;
  /** Injected so a caller can supply the stable id it will retry with. */
  nextId?: () => string;
};

/**
 * `recordMutation()` — the one entry point every write source converges on.
 *
 * Order is deliberate: the fact is journalled (with its index intents, atomically in the journal)
 * before anything tries to deliver or index it. Consumers are downstream of this call and can never
 * turn a successful write into a failed one.
 */
export function createMutationRecorder({ journal, now = Date.now, nextId = createMutationId }: MutationRecorderDependencies) {
  return {
    /**
     * `committedAt` is normally generated here. A repair supplies the original write time instead, so
     * a retried fact keeps describing *when the change landed* rather than when the retry happened.
     */
    async record(input: RecordMutationInput & { id?: string; committedAt?: number }): Promise<RecordedMutation> {
      const event: MutationEvent = { ...input, id: input.id ?? nextId(), committedAt: input.committedAt ?? now() } as MutationEvent;
      if (!isMutationEvent(event)) throw new TypeError("invalid mutation event");
      const digest = await pathDigest(event.path);
      const result = await journal.recordMutation({ event, intents: indexIntentsFor(event) });
      if (!result.inserted) {
        mutationLog("mutation duplicate ignored", { id: event.id, seq: result.seq, source: event.source, op: event.op, pathDigest: digest });
        return { id: event.id, seq: result.seq, inserted: false, duplicate: true };
      }
      mutationLog("mutation recorded", {
        id: event.id,
        seq: result.seq,
        source: event.source,
        op: event.op,
        pathDigest: digest,
      });
      return { id: event.id, seq: result.seq, inserted: true, duplicate: false };
    },
  };
}

export type MutationRecorder = ReturnType<typeof createMutationRecorder>;
