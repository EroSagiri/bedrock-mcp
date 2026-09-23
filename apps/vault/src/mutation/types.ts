/**
 * The Mutation domain: the single vocabulary shared by every knowledge-base writer.
 *
 * A mutation is a **durable fact about an authoritative R2 write that already happened**. It is not
 * a delivery attempt, not an index status, and not a local file apply. Consumers own their own
 * concerns (the Sync Publisher owns delivery, the Index Scheduler owns indexing); nothing consumer
 * specific may leak into this union.
 */

export const MUTATION_SOURCES = ["obsidian", "mcp", "web", "system"] as const;
export type MutationSource = (typeof MUTATION_SOURCES)[number];

/** The longest path this layer will carry; matches the existing sync hint bound. */
export const MAX_MUTATION_PATH_LENGTH = 4096;

type MutationBase = {
  /** Stable, caller-supplied idempotency key. Unique across the whole journal. */
  id: string;
  source: MutationSource;
  /** Vault-record time in epoch milliseconds. Never a claim about distributed wall-clock order. */
  committedAt: number;
};

export type PutMutation = MutationBase & {
  op: "put";
  path: string;
  etag: string;
  size: number;
};

export type DeleteMutation = MutationBase & {
  op: "delete";
  path: string;
};

/**
 * `put` and `delete` are what the first version of this layer guarantees. `rename` is accepted and
 * journalled for completeness, but no existing writer emits it: a rename is decomposed into
 * `delete(from)` + `put(to)` at the source so that the gateway's stable protocol is never widened.
 */
export type RenameMutation = MutationBase & {
  op: "rename";
  from: string;
  path: string;
  etag?: string;
  size?: number;
};

export type MutationEvent = PutMutation | DeleteMutation | RenameMutation;

export function isMutationSource(value: unknown): value is MutationSource {
  return typeof value === "string" && (MUTATION_SOURCES as readonly string[]).includes(value);
}

/** Rejects anything that is not a well-formed, bounded mutation fact. */
export function isMutationEvent(value: unknown): value is MutationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 128) return false;
  if (!isMutationSource(event.source)) return false;
  if (typeof event.committedAt !== "number" || !Number.isFinite(event.committedAt) || event.committedAt < 0) return false;
  const validPath = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= MAX_MUTATION_PATH_LENGTH && !candidate.startsWith("/") && !candidate.includes("\0");
  if (event.op === "put") {
    return validPath(event.path)
      && typeof event.etag === "string" && event.etag.length > 0 && event.etag.length <= 256
      && typeof event.size === "number" && Number.isFinite(event.size) && event.size >= 0;
  }
  if (event.op === "delete") return validPath(event.path);
  if (event.op === "rename") {
    return validPath(event.from) && validPath(event.path)
      && (event.etag === undefined || typeof event.etag === "string" && event.etag.length <= 256)
      && (event.size === undefined || typeof event.size === "number" && Number.isFinite(event.size) && event.size >= 0);
  }
  return false;
}

/** The persisted form: a mutation plus the sequence number the journal assigned to it. */
export type MutationRecord = MutationEvent & { seq: number };

export type BroadcastState = "pending" | "published";

export type JournalEntry = MutationRecord & {
  broadcastState: BroadcastState;
  broadcastAttempts: number;
  broadcastLastError: string | null;
  /** The gateway generation this mutation produced, when it has been delivered. */
  gatewayGeneration: string | null;
};
