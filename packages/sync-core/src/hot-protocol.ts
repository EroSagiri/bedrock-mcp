import { canonicalVaultPath, isCanonicalVaultPath } from "./paths.js";

/**
 * The hot-session protocol (Phase Hot-A).
 *
 * This module is the frozen vocabulary of the realtime layer: document identity, path binding,
 * operation envelopes and their acknowledgements, checkpoint receipts, session acquisition, and the
 * cold-mutation authority lease. It is runtime-neutral on purpose — the Cloudflare Gateway, the
 * plugin, and the tests all speak exactly these shapes, and nothing here may import a Worker binding,
 * a Durable Object stub, an Obsidian API, or a storage handle.
 *
 * Two facts the wire is built around:
 *
 * 1. A document's identity is `DocumentId + Epoch`, never its path. A rename keeps the id and bumps
 *    the epoch, so a message that was in flight during the rename is refused rather than applied to
 *    the new path incarnation.
 * 2. "Accepted" and "saved to R2" are different acknowledgements with different durability
 *    meanings, and no amount of successful transport may be mistaken for the second one.
 */

export const HOT_PROTOCOL_VERSION = 1;

/** One CRDT update; large enough for a long paste, small enough to bound memory per message. */
export const MAX_HOT_UPDATE_BYTES = 1 << 20;
/** The material a room may be seeded with from the authoritative object. */
export const MAX_HOT_SEED_BYTES = 4 << 20;
export const MAX_HOT_CLIENT_ID_LENGTH = 64;
export const MAX_HOT_OPERATION_ID_LENGTH = 128;
/** How long a cold-mutation lease is valid. Long enough for one conditional PUT, short enough to matter. */
export const COLD_AUTHORITY_TTL_MS = 30_000;

const DOCUMENT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export type DocumentId = string;
/** Positive safe integer. `0` is reserved for "this path has never been bound". */
export type DocumentEpoch = number;

export type HotDocumentIdentity = { documentId: DocumentId; epoch: DocumentEpoch };

export function isDocumentId(value: unknown): value is DocumentId {
  return typeof value === "string" && DOCUMENT_ID.test(value);
}

export function isDocumentEpoch(value: unknown): value is DocumentEpoch {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isHotDocumentIdentity(value: unknown): value is HotDocumentIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { documentId?: unknown; epoch?: unknown };
  return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && candidate.epoch >= 1;
}

export function isHotOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

export function isHotClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID.test(value);
}

export function isHotContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH.test(value);
}

/**
 * The content hash a checkpoint receipt names.
 *
 * It is a hash of the **Markdown bytes** the room materialized, not of the CRDT state: the client has
 * to be able to compare it against a local file, and the CRDT encoding is an implementation detail
 * that may change with any Yjs upgrade.
 */
export async function hotContentHash(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeHotPayload(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeHotPayload(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { return undefined; }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* ------------------------------------------------------------------------------------------------
 * Path binding
 * ---------------------------------------------------------------------------------------------- */

export const PATH_BINDING_STATES = ["active", "quiescing", "deleted", "conflicted"] as const;
export type PathBindingState = (typeof PATH_BINDING_STATES)[number];

/**
 * What the namespace currently believes about one path.
 *
 * `epoch` is `0` only for a path that has never carried a document; every real binding carries the
 * epoch of the incarnation it points at, and a *deleted* binding keeps the retired epoch so a late
 * operation can still be told apart from a fresh one.
 */
export type PathBinding = {
  canonicalPath: string;
  documentId: DocumentId | null;
  epoch: DocumentEpoch;
  state: PathBindingState;
  updatedAt: number;
};

export function isPathBinding(value: unknown): value is PathBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isCanonicalVaultPath(candidate.canonicalPath)) return false;
  if (!(candidate.documentId === null || isDocumentId(candidate.documentId))) return false;
  if (!isDocumentEpoch(candidate.epoch)) return false;
  if (!(PATH_BINDING_STATES as readonly unknown[]).includes(candidate.state)) return false;
  if (candidate.documentId === null && candidate.epoch !== 0) return false;
  return typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt);
}

/* ------------------------------------------------------------------------------------------------
 * Effective remote state
 * ---------------------------------------------------------------------------------------------- */

/**
 * What R2 *effectively* holds for a path: an object plus its tombstone, never one without the other.
 *
 * `exists` is the effective answer. `etag` is the current object's revision, which a conditional
 * checkpoint must match. `tombstoneTargets` names the revision a live tombstone retires, so a caller
 * can tell "the object I see was deleted" from "the object I see is newer than a deletion".
 */
export type HotRemoteObservation = {
  canonicalPath: string;
  exists: boolean;
  etag: string | null;
  size: number | null;
  deleted: boolean;
  tombstoneTargets: string | null;
  contentHash: string | null;
};

export function isHotRemoteObservation(value: unknown): value is HotRemoteObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isCanonicalVaultPath(candidate.canonicalPath)) return false;
  if (typeof candidate.exists !== "boolean" || typeof candidate.deleted !== "boolean") return false;
  if (!(candidate.etag === null || typeof candidate.etag === "string")) return false;
  if (!(candidate.size === null || typeof candidate.size === "number")) return false;
  if (!(candidate.tombstoneTargets === null || typeof candidate.tombstoneTargets === "string")) return false;
  return candidate.contentHash === null || isHotContentHash(candidate.contentHash);
}

/* ------------------------------------------------------------------------------------------------
 * Operations and acknowledgements
 * ---------------------------------------------------------------------------------------------- */

export type HotRoomState = "active" | "quiescing" | "deleted" | "conflicted";

/**
 * A client's edit.
 *
 * `parentRevision` is the last server revision the client had applied when it produced the update.
 * It is a *diagnostic*, never an acceptance condition: Yjs updates commute, so refusing one for
 * arriving "late" would lose an edit that merges perfectly well.
 */
export type HotClientOperation = {
  protocol: number;
  type: "operation";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  clientId: string;
  clientOperationId: string;
  /** base64url Yjs update. */
  update: string;
  parentRevision: number;
};

export type HotServerOperation = HotClientOperation & { serverRevision: number };

export type HotRejectionReason =
  | "stale-epoch"
  | "unknown-document"
  | "quiescing"
  | "malformed"
  | "too-large"
  | "unauthorized"
  | "unavailable";

/** The durability acknowledgement: this operation is durably held by the room. */
export type OperationAck = {
  protocol: number;
  type: "ack";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  clientOperationId: string;
  serverRevision: number;
  /** `true` when this was a redelivery and the original revision is being reported again. */
  duplicate: boolean;
};

export type OperationRejection = {
  protocol: number;
  type: "reject";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  clientOperationId: string;
  reason: HotRejectionReason;
};

export type CheckpointReceipt = {
  protocol: number;
  type: "checkpoint";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  canonicalPath: string;
  /** The exact document revision this snapshot covers. Never "the latest". */
  documentRevision: number;
  contentHash: string;
  r2ETag: string | null;
  commitId: string;
  latestAcceptedRevision: number;
  latestCheckpointedRevision: number;
  checkpointedAt: number;
};

export type HotSessionWelcome = {
  protocol: number;
  type: "welcome";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  canonicalPath: string;
  state: HotRoomState;
  serverRevision: number;
  latestCheckpointedRevision: number;
  /** base64url Yjs state: everything a client needs to become convergent. */
  crdtState: string;
  /** `true` while the room holds a checkpoint target that has not landed in R2. */
  pendingSave: boolean;
};

export type HotDocumentStateMessage = {
  protocol: number;
  type: "document-state";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  state: HotRoomState;
  reason?: string;
  canonicalPath?: string;
};

export type HotErrorMessage = {
  protocol: number;
  type: "error";
  code: HotRejectionReason | "internal";
  detail?: string;
};

export type HotServerMessage = HotSessionWelcome | HotServerOperation | OperationAck | OperationRejection | CheckpointReceipt | HotDocumentStateMessage | HotErrorMessage;

export type HotCheckpointRequest = {
  protocol: number;
  type: "checkpoint-request";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  clientId: string;
  clientOperationId: string;
  /** The client wants a receipt covering at least this revision. */
  upToRevision: number;
};

export type HotLeaveMessage = {
  protocol: number;
  type: "leave";
  documentId: DocumentId;
  epoch: DocumentEpoch;
  clientId: string;
  clientOperationId: string;
  /** `true` when the client still wants a checkpoint before its ownership is released. */
  checkpoint: boolean;
};

export type HotPingMessage = { protocol: number; type: "ping" };

export type HotClientMessage = HotClientOperation | HotCheckpointRequest | HotLeaveMessage | HotPingMessage;

function opaqueId(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function isHotClientFrame(value: unknown): value is HotClientMessage {
  return parseHotClientMessage(value) !== undefined;
}

/**
 * Parses one inbound client frame.
 *
 * It returns `undefined` rather than throwing so the socket handler can answer with a rejection that
 * names the operation the client sent: a malformed frame must not take down a session that is
 * carrying unacknowledged edits.
 */
export function parseHotClientMessage(value: unknown): HotClientMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== HOT_PROTOCOL_VERSION) return undefined;
  // A keepalive carries no identity: it is answered before any session lookup, so a socket that is
  // still authenticating does not have to be holding a document id to stay open.
  if (candidate.type === "ping") return { protocol: HOT_PROTOCOL_VERSION, type: "ping" };
  const documentId = opaqueId(candidate.documentId, DOCUMENT_ID);
  const epoch = revision(candidate.epoch);
  if (!documentId || epoch === undefined || epoch < 1) return undefined;
  if (!isHotClientId(candidate.clientId)) return undefined;
  const clientOperationId = opaqueId(candidate.clientOperationId, OPERATION_ID);
  if (!clientOperationId) return undefined;

  if (candidate.type === "operation") {
    const update = candidate.update;
    const decoded = decodeHotPayload(update);
    if (!decoded || decoded.byteLength === 0 || decoded.byteLength > MAX_HOT_UPDATE_BYTES) return undefined;
    const parentRevision = revision(candidate.parentRevision) ?? 0;
    return { protocol: HOT_PROTOCOL_VERSION, type: "operation", documentId, epoch, clientId: candidate.clientId as string, clientOperationId, update: update as string, parentRevision };
  }
  if (candidate.type === "checkpoint-request") {
    const upToRevision = revision(candidate.upToRevision);
    if (upToRevision === undefined) return undefined;
    return { protocol: HOT_PROTOCOL_VERSION, type: "checkpoint-request", documentId, epoch, clientId: candidate.clientId as string, clientOperationId, upToRevision };
  }
  if (candidate.type === "leave") {
    if (typeof candidate.checkpoint !== "boolean") return undefined;
    return { protocol: HOT_PROTOCOL_VERSION, type: "leave", documentId, epoch, clientId: candidate.clientId as string, clientOperationId, checkpoint: candidate.checkpoint };
  }
  return undefined;
}

export function isHotServerFrame(value: unknown): value is HotServerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== HOT_PROTOCOL_VERSION) return false;
  switch (candidate.type) {
    case "welcome":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch)
        && isCanonicalVaultPath(candidate.canonicalPath)
        && (PATH_BINDING_STATES as readonly unknown[]).includes(candidate.state)
        && revision(candidate.serverRevision) !== undefined
        && revision(candidate.latestCheckpointedRevision) !== undefined
        && typeof candidate.crdtState === "string" && decodeHotPayload(candidate.crdtState) !== undefined
        && typeof candidate.pendingSave === "boolean";
    case "operation":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && isHotClientId(candidate.clientId)
        && isHotOperationId(candidate.clientOperationId) && decodeHotPayload(candidate.update) !== undefined
        && revision(candidate.serverRevision) !== undefined;
    case "ack":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && isHotOperationId(candidate.clientOperationId)
        && revision(candidate.serverRevision) !== undefined && typeof candidate.duplicate === "boolean";
    case "reject":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && isHotOperationId(candidate.clientOperationId)
        && typeof candidate.reason === "string";
    case "checkpoint":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && isCanonicalVaultPath(candidate.canonicalPath)
        && revision(candidate.documentRevision) !== undefined && isHotContentHash(candidate.contentHash)
        && (candidate.r2ETag === null || typeof candidate.r2ETag === "string")
        && isHotOperationId(candidate.commitId)
        && revision(candidate.latestAcceptedRevision) !== undefined
        && revision(candidate.latestCheckpointedRevision) !== undefined;
    case "document-state":
      return isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch)
        && (["active", "quiescing", "deleted", "conflicted"] as readonly unknown[]).includes(candidate.state);
    case "error":
      return typeof candidate.code === "string";
    default:
      return false;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Session acquisition and release
 * ---------------------------------------------------------------------------------------------- */

/** What the client believes about the path before it asks for hot ownership. */
export type HotPathExpectation =
  | { state: "absent" }
  | { state: "bound"; documentId: DocumentId; epoch: DocumentEpoch }
  | { state: "unknown" };

export function isHotPathExpectation(value: unknown): value is HotPathExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "absent" || candidate.state === "unknown") return true;
  return candidate.state === "bound" && isDocumentId(candidate.documentId) && isDocumentEpoch(candidate.epoch) && candidate.epoch >= 1;
}

export type HotAcquireReason =
  | "path-taken"
  | "binding-changed"
  | "local-remote-mismatch"
  | "remote-deleted"
  | "remote-changed"
  | "quiescing"
  | "stale-epoch"
  | "unavailable"
  | "invalid";

export type HotAcquireRequest = {
  protocol: number;
  operationId: string;
  canonicalPath: string;
  clientId: string;
  expected: HotPathExpectation;
  /** The client's own view of the file it is about to open, used only to detect a divergence. */
  local: { contentHash: string; size: number } | null;
  /** `false` asks for an observation only (the cold "is this path hot?" question). */
  wantSession: boolean;
};

export type HotAcquireResult = {
  protocol: number;
  outcome: "joined" | "created" | "conflict" | "rejected";
  reason?: HotAcquireReason;
  canonicalPath: string;
  binding: PathBinding | null;
  remote: HotRemoteObservation | null;
  identity?: HotDocumentIdentity;
  serverRevision?: number;
  latestCheckpointedRevision?: number;
  roomState?: HotRoomState;
  /** Short-lived, bound to channel + document + epoch + client. Never the long-lived bearer token. */
  sessionTicket?: string;
  ticketExpiresAt?: number;
};

export type HotReleaseRequest = {
  protocol: number;
  operationId: string;
  clientId: string;
  documentId: DocumentId;
  epoch: DocumentEpoch;
  /** `true` asks the room to checkpoint before the last owner leaves. */
  checkpoint: boolean;
  /** The revision the client has already had acknowledged; the receipt must cover at least this. */
  lastAcceptedRevision: number;
};

export type HotReleaseResult = {
  protocol: number;
  outcome: "released" | "checkpoint-pending" | "not-owner";
  latestAcceptedRevision?: number;
  latestCheckpointedRevision?: number;
  remainingClients?: number;
};

/**
 * The decision a human makes about a frozen hot conflict.
 *
 * It is deliberately two-valued and content-free: `keep-local` says "the content I have is the one that
 * should win, make it the authority again" (re-pointing the room's remote precondition at the state R2
 * holds now, or at the retired revision when the conflict was an external deletion); `accept-remote`
 * says "stop owning this path and let the ordinary cold rules reconcile the file against R2".
 *
 * Neither value carries bytes: the content already exists in one place or the other, and a resolution
 * that had to transmit it could fail halfway and leave both sides wrong.
 */
export type HotConflictResolution = {
  protocol: number;
  operationId: string;
  canonicalPath: string;
  documentId: DocumentId;
  epoch: DocumentEpoch;
  decision: "keep-local" | "accept-remote";
};

export function isHotConflictResolution(value: unknown): value is HotConflictResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HOT_PROTOCOL_VERSION
    && isHotOperationId(candidate.operationId)
    && typeof candidate.canonicalPath === "string" && candidate.canonicalPath.length > 0 && candidate.canonicalPath.length <= 1024
    && isDocumentId(candidate.documentId)
    && isDocumentEpoch(candidate.epoch) && candidate.epoch >= 1
    && (candidate.decision === "keep-local" || candidate.decision === "accept-remote");
}

export function isHotAcquireRequest(value: unknown): value is HotAcquireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HOT_PROTOCOL_VERSION
    && isHotOperationId(candidate.operationId)
    && isCanonicalVaultPath(candidate.canonicalPath)
    && isHotClientId(candidate.clientId)
    && isHotPathExpectation(candidate.expected)
    && (candidate.local === null || (!!candidate.local && typeof candidate.local === "object"
      && isHotContentHash((candidate.local as Record<string, unknown>).contentHash)
      && typeof (candidate.local as Record<string, unknown>).size === "number"))
    && typeof candidate.wantSession === "boolean";
}

export function isHotReleaseRequest(value: unknown): value is HotReleaseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HOT_PROTOCOL_VERSION
    && isHotOperationId(candidate.operationId)
    && isHotClientId(candidate.clientId)
    && isDocumentId(candidate.documentId)
    && isDocumentEpoch(candidate.epoch) && candidate.epoch >= 1
    && typeof candidate.checkpoint === "boolean"
    && revision(candidate.lastAcceptedRevision) !== undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Cold-mutation authority
 * ---------------------------------------------------------------------------------------------- */

/**
 * A cold writer's request to touch one path while hot sessions exist.
 *
 * This exists because "GET /is-hot, then PUT 300 ms later" is a race by construction. The authority is
 * issued by the same object that tracks hot ownership, so a path that becomes hot between the two
 * steps cannot be written under an authority that was granted before it was hot — the lease is
 * verified again before the write.
 */
export type ColdAuthorityRequest = {
  protocol: number;
  operationId: string;
  operation: "put" | "delete";
  canonicalPath: string;
  clientId: string;
  expectedRemoteETag: string | null;
};

export type ColdAuthorityReason = "hot-owned" | "quiescing" | "deleted" | "remote-changed" | "unavailable" | "invalid" | "not-found";

export type ColdAuthorityResult = {
  protocol: number;
  outcome: "granted" | "denied";
  reason?: ColdAuthorityReason;
  token?: string;
  expiresAt?: number;
  binding: PathBinding | null;
  remote: HotRemoteObservation | null;
};

/** What the cold writer reports after it performed the mutation under a lease. */
export type ColdAuthorityCommit = {
  protocol: number;
  token: string;
  operationId: string;
  clientId: string;
  operation: "put" | "delete";
  canonicalPath: string;
  etag: string | null;
  size: number | null;
  committedAt: number;
};

/** A cold writer that has asked for authority and releases it without writing. */
export type ColdAuthorityRelease = { protocol: number; token: string; clientId: string; operationId: string };

export function isColdAuthorityRequest(value: unknown): value is ColdAuthorityRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HOT_PROTOCOL_VERSION
    && isHotOperationId(candidate.operationId)
    && (candidate.operation === "put" || candidate.operation === "delete")
    && isCanonicalVaultPath(candidate.canonicalPath)
    && isHotClientId(candidate.clientId)
    && (candidate.expectedRemoteETag === null || typeof candidate.expectedRemoteETag === "string");
}

export function isColdAuthorityCommit(value: unknown): value is ColdAuthorityCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HOT_PROTOCOL_VERSION
    && typeof candidate.token === "string" && candidate.token.length > 0 && candidate.token.length <= 256
    && isHotOperationId(candidate.operationId)
    && isHotClientId(candidate.clientId)
    && (candidate.operation === "put" || candidate.operation === "delete")
    && isCanonicalVaultPath(candidate.canonicalPath)
    && (candidate.etag === null || typeof candidate.etag === "string")
    && (candidate.size === null || typeof candidate.size === "number")
    && typeof candidate.committedAt === "number" && Number.isFinite(candidate.committedAt);
}

/* ------------------------------------------------------------------------------------------------
 * Session ticket
 * ---------------------------------------------------------------------------------------------- */

/**
 * A short-lived WebSocket credential for one hot session.
 *
 * The plugin cannot attach an `Authorization` header to `new WebSocket(...)`, and a long-lived bearer
 * token must never enter a URL. This ticket is the bridge: signed with the Gateway's existing secret,
 * scoped to one channel *and* one document epoch *and* one client, and useless for anything else.
 */
export type HotSessionTicket = {
  protocol: number;
  ticket: string;
  expiresAt: number;
};

const encoder = new TextEncoder();

function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createHotSessionTicket(input: { channel: string; documentId: DocumentId; epoch: DocumentEpoch; clientId: string; secret: string; ttlMs: number; now: number }): Promise<HotSessionTicket> {
  if (!isDocumentId(input.documentId) || !isDocumentEpoch(input.epoch) || input.epoch < 1) throw new TypeError("a hot session ticket requires a document identity");
  if (!isHotClientId(input.clientId)) throw new TypeError("a hot session ticket requires a client id");
  if (!input.secret) throw new TypeError("a hot session ticket requires a signing secret");
  const expiresAt = input.now + Math.max(1, Math.floor(input.ttlMs));
  const payload = ["h1", input.channel, input.documentId, String(input.epoch), input.clientId, String(expiresAt)].join(".");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(input.secret), encoder.encode(payload));
  return { protocol: HOT_PROTOCOL_VERSION, ticket: `${payload}.${encodeHotPayload(new Uint8Array(signature))}`, expiresAt };
}

export async function verifyHotSessionTicket(input: { ticket: string | undefined; channel: string; secret: string; now: number }): Promise<{ documentId: DocumentId; epoch: DocumentEpoch; clientId: string } | undefined> {
  const ticket = input.ticket;
  if (!ticket || !input.secret) return undefined;
  const parts = ticket.split(".");
  if (parts.length !== 7) return undefined;
  const [version, channel, documentId, epoch, clientId, expiresAt, signature] = parts;
  if (version !== "h1" || channel !== input.channel) return undefined;
  if (!isDocumentId(documentId) || !isHotClientId(clientId)) return undefined;
  if (!/^\d+$/.test(epoch) || !isDocumentEpoch(Number(epoch)) || Number(epoch) < 1) return undefined;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= input.now) return undefined;
  const decoded = decodeHotPayload(signature);
  if (!decoded) return undefined;
  const provided = new Uint8Array(decoded.byteLength);
  provided.set(decoded);
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(input.secret), provided, encoder.encode([version, channel, documentId, epoch, clientId, expiresAt].join(".")));
    return valid ? { documentId, epoch: Number(epoch), clientId } : undefined;
  } catch { return undefined; }
}

/* ------------------------------------------------------------------------------------------------
 * Checkpoint targets (server-internal, but shared so the tests and the recovery path agree)
 * ---------------------------------------------------------------------------------------------- */

export type CheckpointTarget = {
  documentId: DocumentId;
  epoch: DocumentEpoch;
  canonicalPath: string;
  documentRevision: number;
  contentHash: string;
  commitId: string;
  expectedRemoteETag: string | null;
  createdAt: number;
  attempts: number;
};

export function isCheckpointTarget(value: unknown): value is CheckpointTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isDocumentId(candidate.documentId)
    && isDocumentEpoch(candidate.epoch) && candidate.epoch >= 1
    && isCanonicalVaultPath(candidate.canonicalPath)
    && revision(candidate.documentRevision) !== undefined
    && isHotContentHash(candidate.contentHash)
    && isHotOperationId(candidate.commitId)
    && (candidate.expectedRemoteETag === null || typeof candidate.expectedRemoteETag === "string")
    && typeof candidate.createdAt === "number"
    && typeof candidate.attempts === "number";
}

/** The identity a conflict UI binds its decision to. Any change to these inputs makes the decision stale. */
export function conflictIdentity(parts: readonly (string | number | null | undefined)[]): string {
  return parts.map(part => part === null || part === undefined ? "-" : String(part).replace(/[|\n]/g, "_")).join("|");
}

/** Re-exported so a hot-only importer does not have to reach for a second module. */
export { canonicalVaultPath, isCanonicalVaultPath };



/** A manual decision bound to all server versions displayed by the resolver. */
export interface HotMergedResolution {
  confirmOnly?: boolean;
  protocol: number;
  operationId: string;
  canonicalPath: string;
  documentId: DocumentId;
  epoch: DocumentEpoch;
  decision: "merged";
  expectedRevision: number;
  expectedContentHash: string;
  expectedRemoteETag: string | null;
  content: string;
}
export interface HotResolutionSnapshot {
  expectedRemoteETag: string | null;
  documentId: DocumentId;
  epoch: DocumentEpoch;
  revision: number;
  checkpointedRevision: number;
  contentHash: string;
  content: string;
  state: HotRoomState;
  remoteETag: string | null;
  remoteContent: string;
}
export interface HotMergedResolutionResult {
  outcome: "saved" | "pending" | "stale" | "not-found";
  revision?: number;
}
export function isHotMergedResolution(value: unknown): value is HotMergedResolution {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.protocol === HOT_PROTOCOL_VERSION && v.decision === "merged"
    && isHotOperationId(v.operationId) && isCanonicalVaultPath(v.canonicalPath)
    && isDocumentId(v.documentId) && isDocumentEpoch(v.epoch) && (v.epoch as number) >= 1
    && Number.isSafeInteger(v.expectedRevision) && (v.expectedRevision as number) >= 0
    && isHotContentHash(v.expectedContentHash)
    && (v.expectedRemoteETag === null || typeof v.expectedRemoteETag === "string")
    && typeof v.content === "string" && new TextEncoder().encode(v.content).byteLength <= 1024 * 1024;
}
