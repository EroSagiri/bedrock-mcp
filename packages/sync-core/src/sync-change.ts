export type RemoteGeneration = string;

export type RemoteChangeSource = "obsidian" | "vault" | "mcp" | "system" | "unknown";
export type RemoteChangeKind = "upsert" | "delete" | "unknown";

/** A bounded diagnostic hint; it never changes Hub correctness semantics. */
export type RemoteChangeHint = {
  source?: RemoteChangeSource;
  kind?: RemoteChangeKind;
  writerId?: string;
  pathHash?: string;
  /**
   * The writer's mutation idempotency key.
   *
   * A writer that retries a notification whose response was lost must not create a second
   * generation, so the Hub remembers `mutationId → generation` for a bounded window and replays the
   * original answer. It is optional: a client that does not send one keeps the legacy behaviour.
   */
  mutationId?: string;
};

/** A bounded, path-scoped fact accompanying one gateway generation. */
export type RemoteChange =
  | { op: "put"; path: string; etag?: string; size?: number; modified?: string }
  | { op: "delete"; path: string }
  | { op: "rename"; from: string; to: string; etag?: string };

export type MarkRemoteDirtyRequest = RemoteChangeHint & {
  channel: string;
  /** Omitted means a compatibility-only level-triggered wake-up. */
  changes?: RemoteChange[];
};

export type MarkRemoteDirtyResult = { generation: RemoteGeneration };

/**
 * A mutation as a **client** reports it.
 *
 * A client writes R2 itself and then tells the control plane what it did. The shape is deliberately
 * identical to the Vault's `MutationEvent` minus `source` (the control plane knows which writer
 * category a client is) and minus `committedAt`, which the reporter stamps from its own clock.
 */
export type ReportedMutation =
  | { id: string; op: "put"; path: string; etag: string; size: number; committedAt: number }
  | { id: string; op: "delete"; path: string; etag?: string; committedAt: number };

/**
 * What the authority decided about a report.
 *
 * This is the whole reason reports travel through the control plane instead of being fire-and-forget:
 * the verdict comes back to the client, which needs it to decide whether retrying is worth anything.
 */
export type MutationVerdict =
  | { verdict: "accepted"; seq: number }
  | { verdict: "duplicate"; seq: number }
  /** `revoked` means a newer writer removed the stored secret for this client. */
  | { verdict: "refused"; reason: "state-mismatch" | "invalid" | "unknown-channel" | "unavailable" | "revoked" };

/** Bounded in the same places the authority bounds it, so garbage cannot reach a journal. */
export function isReportedMutation(value: unknown): value is ReportedMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mutation = value as Record<string, unknown>;
  if (typeof mutation.id !== "string" || mutation.id.length === 0 || mutation.id.length > 128) return false;
  if (typeof mutation.committedAt !== "number" || !Number.isFinite(mutation.committedAt) || mutation.committedAt < 0) return false;
  const path = mutation.path;
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.startsWith("/") || path.includes("\0")) return false;
  if (mutation.op === "put") {
    return typeof mutation.etag === "string" && mutation.etag.length > 0 && mutation.etag.length <= 256
      && typeof mutation.size === "number" && Number.isFinite(mutation.size) && mutation.size >= 0;
  }
  if (mutation.op === "delete") {
    return mutation.etag === undefined || typeof mutation.etag === "string" && mutation.etag.length > 0 && mutation.etag.length <= 256;
  }
  return false;
}

export function isMutationVerdict(value: unknown): value is MutationVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const verdict = (value as { verdict?: unknown }).verdict;
  if (verdict === "accepted" || verdict === "duplicate") return typeof (value as { seq?: unknown }).seq === "number";
  if (verdict !== "refused") return false;
  const reason = (value as { reason?: unknown }).reason;
  return reason === "state-mismatch" || reason === "invalid" || reason === "unknown-channel" || reason === "unavailable" || reason === "revoked";
}

/**
 * Generations are opaque, monotonically non-decreasing decimal integers. They are deliberately
 * **not** comparable to the plugin's local `syncDirtyVersion`: the two number spaces describe
 * different things (remote wake-up level vs. local single-flight coalescing) and must never be
 * mixed. Comparison goes through `BigInt`, because `Number` silently loses precision above 2^53.
 */
const DECIMAL = /^(0|[1-9]\d*)$/;

export function isRemoteGeneration(value: unknown): value is RemoteGeneration {
  return typeof value === "string" && DECIMAL.test(value);
}

/** `undefined` for a malformed generation, so callers cannot accidentally compare junk. */
export function parseRemoteGeneration(value: unknown): bigint | undefined {
  return isRemoteGeneration(value) ? BigInt(value) : undefined;
}

/** Canonical decimal string: no sign, no leading zeroes, no exponent. */
export function formatRemoteGeneration(value: bigint): RemoteGeneration {
  return value < 0n ? "0" : value.toString();
}

export function compareRemoteGeneration(left: RemoteGeneration, right: RemoteGeneration): number {
  const a = parseRemoteGeneration(left), b = parseRemoteGeneration(right);
  if (a === undefined || b === undefined) throw new TypeError("compareRemoteGeneration requires decimal-string generations");
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The two client cursors from the Phase 4A control-plane contract.
 *
 * - `highestAnnouncedGeneration` may advance as soon as a valid generation is seen.
 * - `lastReconciledGeneration` may only advance after a complete reconciliation window proved it.
 *
 * Both are canonical decimal strings; the empty string means "no observation yet".
 */
export type RemoteGenerationCursor = {
  highestAnnouncedGeneration: RemoteGeneration;
  lastReconciledGeneration: RemoteGeneration;
};

export function emptyGenerationCursor(): RemoteGenerationCursor {
  return { highestAnnouncedGeneration: "0", lastReconciledGeneration: "0" };
}

/** Extracts a cursor from persisted or malformed storage without ever trusting it. */
export function parseGenerationCursor(value: unknown): RemoteGenerationCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyGenerationCursor();
  const candidate = value as { highestAnnouncedGeneration?: unknown; lastReconciledGeneration?: unknown };
  return {
    highestAnnouncedGeneration: isRemoteGeneration(candidate.highestAnnouncedGeneration) ? candidate.highestAnnouncedGeneration : "0",
    lastReconciledGeneration: isRemoteGeneration(candidate.lastReconciledGeneration) ? candidate.lastReconciledGeneration : "0",
  };
}

export function advanceAnnouncedGeneration(cursor: RemoteGenerationCursor, generation: unknown): RemoteGenerationCursor {
  const parsed = parseRemoteGeneration(generation);
  if (parsed === undefined) return cursor;
  return compareRemoteGeneration(formatRemoteGeneration(parsed), cursor.highestAnnouncedGeneration) > 0
    ? { ...cursor, highestAnnouncedGeneration: formatRemoteGeneration(parsed) }
    : cursor;
}

/**
 * A level-triggered remote-dirty signal is pending exactly while the last announcement is ahead of
 * the last generation a full reconciliation was able to confirm. This is the whole reason two
 * cursors exist instead of one.
 */
export function isRemoteReconcilePending(cursor: RemoteGenerationCursor): boolean {
  return compareRemoteGeneration(cursor.highestAnnouncedGeneration, cursor.lastReconciledGeneration) > 0;
}

/**
 * Advances the confirmed cursor only if `generation` is genuinely ahead of it. A cursor never moves
 * backwards, so a stale or duplicated acknowledgement cannot re-open an already-covered window.
 */
export function confirmReconciledGeneration(cursor: RemoteGenerationCursor, generation: unknown): RemoteGenerationCursor {
  const parsed = parseRemoteGeneration(generation);
  if (parsed === undefined) return cursor;
  return compareRemoteGeneration(formatRemoteGeneration(parsed), cursor.lastReconciledGeneration) > 0
    ? { ...cursor, lastReconciledGeneration: formatRemoteGeneration(parsed) }
    : cursor;
}
