import type { CheckpointReceipt, DocumentEpoch, DocumentId, HotDocumentIdentity, PathBinding } from "./hot-protocol.js";
import { isDocumentEpoch, isDocumentId, isHotClientId, isHotContentHash, isHotDocumentIdentity, isHotOperationId, isPathBinding } from "./hot-protocol.js";
import { isCanonicalVaultPath } from "./paths.js";

/**
 * Namespace lifecycle: create, delete, rename (Phase Hot-A).
 *
 * CRDT owns document *content*. These three own the namespace: which path addresses which document
 * incarnation. They are not text operations, they never enter a body undo history, and they cannot be
 * expressed as "the file is now empty" — an empty document and a deleted document are different
 * states, and the tombstone model depends on that distinction.
 *
 * Every intent carries an `operationId`, and every one is idempotent: a client that loses the response
 * and retries the same id must get the original result back rather than a second mutation.
 */

export const NAMESPACE_PROTOCOL_VERSION = 1;

export const NAMESPACE_PHASES = ["requested", "quiescing", "checkpointed", "r2-applied", "binding-updated", "acked", "failed"] as const;
export type NamespacePhase = (typeof NAMESPACE_PHASES)[number];

export type NamespaceOutcome = "applied" | "pending" | "conflict" | "rejected" | "duplicate";

export type NamespaceReason =
  | "path-taken"
  | "target-exists"
  | "binding-changed"
  | "source-missing"
  | "stale-epoch"
  | "stale-intent"
  | "quiescing"
  | "checkpoint-failed"
  | "remote-changed"
  | "remote-deleted"
  | "unknown-document"
  | "unavailable"
  | "invalid"
  /**
   * Nobody was left to finish it.
   *
   * A namespace operation is resumed by the coordinator itself when the client that started it goes
   * away, and the attempts are bounded: past the limit the operation fails *explicitly* and releases the
   * path, because a path stuck in `quiescing` forever is worse than a reported failure.
   */
  | "resume-exhausted";

/** The state the requester believes a path is in. The coordinator compares it to its own binding. */
export type ExpectedPathState =
  | { state: "absent" }
  | { state: "bound"; documentId: DocumentId; epoch: DocumentEpoch }
  | { state: "unknown" };

export type NamespaceIntent =
  | {
    protocol: number;
    type: "create";
    operationId: string;
    clientId: string;
    canonicalPath: string;
    expectedPathState: { state: "absent" };
    /** The creating client's own material, used only as a diagnostic of what the first checkpoint will hold. */
    local: { contentHash: string; size: number } | null;
  }
  | {
    protocol: number;
    type: "delete";
    operationId: string;
    clientId: string;
    canonicalPath: string;
    documentId: DocumentId;
    expectedEpoch: DocumentEpoch;
    /** The exact remote revision the deletion intends to retire; `null` means "the path is absent". */
    expectedRemoteETag: string | null;
    /** The document revision the deleting client has already had acknowledged, when it had a session. */
    expectedDocumentRevision: number | null;
  }
  | {
    protocol: number;
    type: "rename";
    operationId: string;
    clientId: string;
    fromPath: string;
    toPath: string;
    documentId: DocumentId;
    expectedEpoch: DocumentEpoch;
    expectedFromBinding: { documentId: DocumentId; epoch: DocumentEpoch } | null;
    expectedToPathState: { state: "absent" };
  };

export type NamespaceResult = {
  protocol: number;
  operationId: string;
  type: NamespaceIntent["type"];
  outcome: NamespaceOutcome;
  reason?: NamespaceReason;
  phase: NamespacePhase;
  canonicalPath: string;
  fromPath?: string;
  /** The binding the intent addressed: the target for create, the source for delete/rename. */
  binding: PathBinding | null;
  /** Present only for a rename: the binding of the newly claimed path. */
  targetBinding?: PathBinding | null;
  /** Present only for a rename: what the source path became, so both halves are reported together. */
  fromBinding?: PathBinding | null;
  identity?: HotDocumentIdentity;
  checkpoint?: CheckpointReceipt;
};

/** The durable record the coordinator keeps per namespace operation, so a crash is recoverable. */
export type NamespaceOperationRecord = {
  operationId: string;
  type: NamespaceIntent["type"];
  phase: NamespacePhase;
  canonicalPath: string;
  fromPath: string | null;
  intent: NamespaceIntent;
  result: NamespaceResult | null;
  updatedAt: number;
};

export function isNamespacePhase(value: unknown): value is NamespacePhase {
  return typeof value === "string" && (NAMESPACE_PHASES as readonly string[]).includes(value);
}

export function isNamespaceOutcome(value: unknown): value is NamespaceOutcome {
  return typeof value === "string" && (["applied", "pending", "conflict", "rejected", "duplicate"] as readonly string[]).includes(value);
}

export function isNamespaceIntent(value: unknown): value is NamespaceIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== NAMESPACE_PROTOCOL_VERSION) return false;
  if (!isHotOperationId(candidate.operationId) || !isHotClientId(candidate.clientId)) return false;

  if (candidate.type === "create") {
    const expected = candidate.expectedPathState as Record<string, unknown> | undefined;
    const local = candidate.local as Record<string, unknown> | null | undefined;
    return isCanonicalVaultPath(candidate.canonicalPath)
      && !!expected && expected.state === "absent"
      && (local === null || (!!local && isHotContentHash(local.contentHash) && typeof local.size === "number" && local.size >= 0));
  }
  if (candidate.type === "delete") {
    return isCanonicalVaultPath(candidate.canonicalPath)
      && isDocumentId(candidate.documentId)
      && isDocumentEpoch(candidate.expectedEpoch) && candidate.expectedEpoch >= 1
      && (candidate.expectedRemoteETag === null || typeof candidate.expectedRemoteETag === "string")
      && (candidate.expectedDocumentRevision === null || (typeof candidate.expectedDocumentRevision === "number" && Number.isSafeInteger(candidate.expectedDocumentRevision)));
  }
  if (candidate.type === "rename") {
    const from = candidate.expectedFromBinding as Record<string, unknown> | null | undefined;
    const to = candidate.expectedToPathState as Record<string, unknown> | undefined;
    return isCanonicalVaultPath(candidate.fromPath) && isCanonicalVaultPath(candidate.toPath)
      && candidate.fromPath !== candidate.toPath
      && isDocumentId(candidate.documentId)
      && isDocumentEpoch(candidate.expectedEpoch) && candidate.expectedEpoch >= 1
      && (from === null || (!!from && isDocumentId(from.documentId) && isDocumentEpoch(from.epoch)))
      && !!to && to.state === "absent";
  }
  return false;
}

export function isNamespaceResult(value: unknown): value is NamespaceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== NAMESPACE_PROTOCOL_VERSION) return false;
  if (!isHotOperationId(candidate.operationId)) return false;
  if (!(candidate.type === "create" || candidate.type === "delete" || candidate.type === "rename")) return false;
  if (!isNamespaceOutcome(candidate.outcome) || !isNamespacePhase(candidate.phase)) return false;
  if (!isCanonicalVaultPath(candidate.canonicalPath)) return false;
  if (candidate.fromPath !== undefined && !isCanonicalVaultPath(candidate.fromPath)) return false;
  if (candidate.binding !== null && !isPathBinding(candidate.binding)) return false;
  if (candidate.targetBinding !== undefined && candidate.targetBinding !== null && !isPathBinding(candidate.targetBinding)) return false;
  if (candidate.fromBinding !== undefined && candidate.fromBinding !== null && !isPathBinding(candidate.fromBinding)) return false;
  if (candidate.identity !== undefined && !isHotDocumentIdentity(candidate.identity)) return false;
  return true;
}

