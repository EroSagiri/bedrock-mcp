import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import type { HotCheckpointResult, HotDeleteResult, HotMoveResult, VaultHotRpc } from "@mineral/core/vault-rpc";
import {
  HOT_PROTOCOL_VERSION,
  decodeHotPayload,
  encodeHotPayload,
  hotContentHash,
  parseHotClientMessage,
  type CheckpointReceipt,
  type CheckpointTarget,
  type DocumentEpoch,
  type HotClientMessage,
  type HotRoomState,
  type HotServerOperation,
} from "@mineral/sync-core/hot-protocol";

/**
 * LiveDocumentRoom — the durable realtime document (Phase Hot-B).
 *
 * One Durable Object per `DocumentId`, not per path and not per session. That is the consequence of
 * the identity decision in the design: a rename changes the path and bumps the epoch, but it must not
 * move the document's history to a different object, or every in-flight operation and every pending
 * checkpoint would have to be migrated at exactly the moment when the system is least able to afford
 * it.
 *
 * What this object owns:
 *
 * - the CRDT state (`Y.Doc`) and the operation log that rebuilds it,
 * - operation deduplication, so a retransmission cannot be applied twice,
 * - the epoch fence, so a message from before a rename cannot land in the incarnation after it,
 * - the checkpoint schedule (durable alarms, not in-memory timers) and the pending target,
 * - the durability acknowledgement, which is the promise that the *server* — not the sending client —
 *   will get this content into R2.
 *
 * What it deliberately does not own: R2. Every checkpoint goes through the Vault over a service
 * binding, because the Vault owns the conditional write, the journal, and the prefix composition.
 *
 * Recovery shape: the object can be evicted at any moment, so nothing here may depend on memory. The
 * doc is rebuilt from a snapshot plus the operations after it, and the checkpoint target is persisted
 * *before* the R2 call, so a crash in the middle of the call is recoverable rather than a lost save.
 */

/** A pause in editing that settles a revision. */
export const HOT_DEBOUNCE_MS = 2_000;
/**
 * The longest a revision may stay un-checkpointed while editing continues.
 *
 * This is a *trigger* target, not a completion SLA: when R2 is failing, the target stays durable and
 * the room keeps retrying, and the client is told the save is pending rather than saved.
 */
export const HOT_MAX_CHECKPOINT_INTERVAL_MS = 10_000;
export const HOT_RETRY_BASE_MS = 1_000;
export const HOT_RETRY_CAP_MS = 30_000;
/** Matches the Vault's own bound; a larger snapshot would be refused there anyway. */
export const HOT_MAX_MATERIALIZED_BYTES = 4 << 20;
/** Compact the operation log into the snapshot once it grows past this many rows. */
const COMPACTION_OPERATION_LIMIT = 256;

/**
 * When the next checkpoint is due for a document that is dirty since `dirtySince`.
 *
 * Two numbers from the design, in one place and testable without waiting for a clock: editing settles a
 * revision after {@link HOT_DEBOUNCE_MS} of quiet, and continuous editing may not postpone a save past
 * {@link HOT_MAX_CHECKPOINT_INTERVAL_MS} from the first unsaved change. The second bound is what makes
 * "keep typing forever" converge at all — without it, a long editing session would reach R2 only when it
 * stopped, and a crash would lose the whole session instead of the last few seconds.
 */
export function hotCheckpointDelayMs(dirtySince: number, now: number): number {
  return Math.max(0, Math.min(now + HOT_DEBOUNCE_MS, dirtySince + HOT_MAX_CHECKPOINT_INTERVAL_MS) - now);
}

export type RoomDescription = {
  documentId: string;
  epoch: DocumentEpoch;
  canonicalPath: string;
  state: HotRoomState;
  latestAcceptedRevision: number;
  latestCheckpointedRevision: number;
  baseContentHash: string;
  currentContentHash: string;
  expectedRemoteETag: string | null;
  pendingSave: boolean;
  conflicted: boolean;
  clients: number;
};

export type RoomBootstrapInput = {
  documentId: string;
  epoch: DocumentEpoch;
  canonicalPath: string;
  /** The knowledge base this document belongs to; the room needs it to name its coordinator. */
  channel: string;
  /** The authoritative material a new incarnation is adopted from, when R2 holds one. */
  seed: { content: string; etag: string } | null;
  /** The revision the room must match on its first checkpoint; `null` means "the path must not exist". */
  expectedRemoteETag: string | null;
  /** `true` when that revision is already tombstoned, i.e. this room *is* the recreation. */
  replaceTombstonedRevision: boolean;
};

export type RoomQuiesceResult = {
  ok: true;
  epoch: DocumentEpoch;
  canonicalPath: string;
  documentRevision: number;
  contentHash: string;
  markdown: string;
  expectedRemoteETag: string | null;
  receipt: CheckpointReceipt | null;
} | { ok: false; reason: "stale-epoch" | "unknown-document" | "checkpoint-conflict"; conflicted: boolean };

export class LiveDocumentRoom extends DurableObject<GatewayHotEnv> {
  private loaded = false;
  private doc: Y.Doc | undefined;
  private room: RoomRow | undefined;
  /** Set when a storage failure made the in-memory doc untrustworthy; the next entry reloads it. */
  private poisoned = false;

  constructor(ctx: DurableObjectState, env: GatewayHotEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.schema();
    });
  }

  /**
   * The Vault, as an overridable seam.
   *
   * Cloudflare cannot be asked to route a Durable Object's service binding in a local test, so the
   * test deployment overrides this with the Vault entrypoint's own RPC stub. Production returns the
   * deployed binding, unchanged, and there is no other override in this class.
   */
  protected vault(): VaultHotRpc | undefined {
    return this.env.VAULT as unknown as VaultHotRpc | undefined;
  }

  /** The namespace this document belongs to; the room reports back when it stops being held. */
  protected coordinator(): { getByName(name: string): CoordinatorSurface } | undefined {
    return this.env.COORDINATOR;
  }

  private sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private schema(): void {
    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS room (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        document_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        canonical_path TEXT NOT NULL,
        state TEXT NOT NULL,
        latest_accepted_revision INTEGER NOT NULL,
        latest_checkpointed_revision INTEGER NOT NULL,
        expected_remote_etag TEXT,
        base_content_hash TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT '',
        replace_tombstoned INTEGER NOT NULL DEFAULT 0,
        snapshot BLOB NOT NULL,
        snapshot_revision INTEGER NOT NULL,
        pending_target TEXT,
        dirty_since INTEGER,
        retry_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        client_id TEXT NOT NULL,
        client_operation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        update_blob BLOB NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, client_operation_id)
      );
      CREATE INDEX IF NOT EXISTS operations_revision ON operations(revision);
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        joined_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
  }

  private now(): number {
    return Date.now();
  }

  private reload(): void {
    this.loaded = false;
    this.doc = undefined;
    this.room = undefined;
    this.poisoned = false;
  }

  /** Rebuilds the document from durable state: one snapshot plus the operations that followed it. */
  private async load(): Promise<void> {
    if (this.loaded && !this.poisoned) return;
    const rows = [...this.sql().exec<RoomDbRow>("SELECT * FROM room WHERE id = 1")];
    if (rows.length === 0) {
      this.loaded = true;
      this.poisoned = false;
      this.doc = undefined;
      this.room = undefined;
      return;
    }
    const row = rows[0];
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytesOf(row.snapshot));
    for (const operation of this.sql().exec<{ update_blob: ArrayBuffer }>(
      "SELECT update_blob FROM operations WHERE revision > ? ORDER BY revision ASC",
      row.snapshot_revision,
    )) {
      Y.applyUpdate(doc, bytesOf(operation.update_blob));
    }
    this.doc = doc;
    this.room = {
      documentId: String(row.document_id),
      epoch: Number(row.epoch),
      canonicalPath: String(row.canonical_path),
      state: String(row.state) as HotRoomState,
      latestAcceptedRevision: Number(row.latest_accepted_revision),
      latestCheckpointedRevision: Number(row.latest_checkpointed_revision),
      expectedRemoteETag: row.expected_remote_etag === null ? null : String(row.expected_remote_etag),
      baseContentHash: String(row.base_content_hash),
      channel: String(row.channel ?? ""),
      replaceTombstoned: Number(row.replace_tombstoned ?? 0) === 1,
      snapshotRevision: Number(row.snapshot_revision),
      pendingTarget: parseTarget(row.pending_target),
      dirtySince: row.dirty_since === null ? null : Number(row.dirty_since),
      retryAttempts: Number(row.retry_attempts ?? 0),
      nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
      lastError: row.last_error === null ? null : String(row.last_error),
    };
    this.loaded = true;
    this.poisoned = false;
  }

  private markdown(): string {
    return this.doc?.getText("markdown").toString() ?? "";
  }

  /**
   * Whether a checkpoint raised a conflict.
   *
   * A method rather than a field read because the answer changes *during* `checkpointNow()`: the
   * compiler cannot see through the call, and pretending it can is how a room gets reset to "active"
   * over a conflict that was never resolved.
   */
  private conflictedNow(): boolean {
    return this.room?.state === "conflicted";
  }

  private persist(snapshot = true): void {
    const room = this.room;
    if (!room) return;
    const snapshotBytes = snapshot ? toArrayBuffer(Y.encodeStateAsUpdate(this.doc ?? new Y.Doc())) : null;
    this.sql().exec(
      `UPDATE room SET document_id = ?, epoch = ?, canonical_path = ?, state = ?, latest_accepted_revision = ?,
        latest_checkpointed_revision = ?, expected_remote_etag = ?, base_content_hash = ?, channel = ?, replace_tombstoned = ?,
        snapshot = COALESCE(?, snapshot), snapshot_revision = ?, pending_target = ?, dirty_since = ?,
        retry_attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = 1`,
      room.documentId,
      room.epoch,
      room.canonicalPath,
      room.state,
      room.latestAcceptedRevision,
      room.latestCheckpointedRevision,
      room.expectedRemoteETag,
      room.baseContentHash,
      room.channel,
      room.replaceTombstoned ? 1 : 0,
      snapshotBytes,
      snapshot ? room.latestAcceptedRevision : room.snapshotRevision,
      room.pendingTarget ? JSON.stringify(room.pendingTarget) : null,
      room.dirtySince,
      room.retryAttempts,
      room.nextAttemptAt,
      room.lastError,
      this.now(),
    );
    if (snapshot) room.snapshotRevision = room.latestAcceptedRevision;
  }

  private async describeInternal(): Promise<RoomDescription> {
    const room = this.room;
    if (!room) throw new Error("room is not bootstrapped");
    return {
      documentId: room.documentId,
      epoch: room.epoch,
      canonicalPath: room.canonicalPath,
      state: room.state,
      latestAcceptedRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      baseContentHash: room.baseContentHash,
      currentContentHash: await hotContentHash(this.markdown()),
      expectedRemoteETag: room.expectedRemoteETag,
      pendingSave: room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null,
      conflicted: room.state === "conflicted",
      clients: this.ctx.getWebSockets().length,
    };
  }

  /* --------------------------------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------------------------------ */

  /**
   * Creates (or re-creates) the room.
   *
   * A seed is content the authoritative object already holds, and it is adopted rather than pushed:
   * the room starts at revision 1 with revision 1 already checkpointed, because those bytes are
   * already in R2. That is what keeps a client's "join an existing document" from becoming a
   * full-document insert that fights with everyone else's history.
   */
  async bootstrap(input: RoomBootstrapInput): Promise<RoomDescription> {
    await this.load();
    if (this.room) return this.describeInternal();
    const doc = new Y.Doc();
    const seeded = input.seed !== null;
    if (seeded) doc.getText("markdown").insert(0, input.seed!.content);
    const now = this.now();
    const room: RoomRow = {
      documentId: input.documentId,
      epoch: input.epoch,
      canonicalPath: input.canonicalPath,
      state: "active",
      latestAcceptedRevision: seeded ? 1 : 0,
      latestCheckpointedRevision: seeded ? 1 : 0,
      expectedRemoteETag: input.seed ? input.seed.etag : input.expectedRemoteETag,
      baseContentHash: seeded ? await hotContentHash(input.seed!.content) : await hotContentHash(""),
      channel: input.channel,
      // Only a room born on a tombstoned revision may replace it; every other room must treat a live
      // tombstone as somebody else's deletion.
      replaceTombstoned: input.replaceTombstonedRevision,
      snapshotRevision: seeded ? 1 : 0,
      pendingTarget: null,
      dirtySince: null,
      retryAttempts: 0,
      nextAttemptAt: null,
      lastError: null,
    };
    this.doc = doc;
    this.room = room;
    this.sql().exec(
      `INSERT INTO room (id, document_id, epoch, canonical_path, state, latest_accepted_revision,
        latest_checkpointed_revision, expected_remote_etag, base_content_hash, channel, replace_tombstoned,
        snapshot, snapshot_revision, pending_target, dirty_since, retry_attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?)`,
      room.documentId,
      room.epoch,
      room.canonicalPath,
      room.state,
      room.latestAcceptedRevision,
      room.latestCheckpointedRevision,
      room.expectedRemoteETag,
      room.baseContentHash,
      room.channel,
      room.replaceTombstoned ? 1 : 0,
      toArrayBuffer(Y.encodeStateAsUpdate(doc)),
      room.snapshotRevision,
      now,
      now,
    );
    this.loaded = true;
    return this.describeInternal();
  }

  async describe(): Promise<RoomDescription | null> {
    await this.load();
    return this.room ? this.describeInternal() : null;
  }

  /** Whether this doc id exists at all, without materializing anything. */
  async exists(): Promise<boolean> {
    await this.load();
    return this.room !== undefined;
  }

  /**
   * Stops accepting body operations so a namespace transition can checkpoint a settled revision.
   *
   * The room does not close its sockets here: its clients are still the ones that will apply the
   * rename or the deletion locally, and they need to be told what happened.
   */
  async quiesce(input: { expectedEpoch: DocumentEpoch; mode: "delete" | "rename"; upToRevision: number | null }): Promise<RoomQuiesceResult> {
    await this.load();
    const room = this.room;
    if (!room) return { ok: false, reason: "unknown-document", conflicted: false };
    if (room.epoch !== input.expectedEpoch) return { ok: false, reason: "stale-epoch", conflicted: false };
    if (room.state !== "active") return { ok: false, reason: "checkpoint-conflict", conflicted: true };

    room.state = "quiescing";
    this.persist();
    // A room with nothing outstanding has nothing to save, and that is a success, not a failure: it
    // already holds a checkpoint for exactly the revision a namespace transition needs to build on.
    const pending = room.latestAcceptedRevision > room.latestCheckpointedRevision || room.pendingTarget !== null;
    const receipt = pending ? await this.checkpointNow() : await this.lastReceipt();
    if (pending && !receipt) {
      // `checkpointNow` may have raised a conflict while it ran; the room has to keep whatever it
      // decided rather than being reset to "active" by the caller's optimistic path.
      const conflicted = this.conflictedNow();
      if (!conflicted) room.state = "active";
      this.persist();
      return { ok: false, reason: "checkpoint-conflict", conflicted };
    }
    return {
      ok: true,
      epoch: room.epoch,
      canonicalPath: room.canonicalPath,
      documentRevision: room.latestCheckpointedRevision,
      contentHash: room.baseContentHash,
      markdown: this.markdown(),
      expectedRemoteETag: room.expectedRemoteETag,
      receipt,
    };
  }

  /** Moves the room to the next incarnation after a rename. Old-epoch traffic is refused from here on. */
  async renameEpoch(input: { expectedEpoch: DocumentEpoch; newEpoch: DocumentEpoch; canonicalPath: string; etag: string; contentHash: string }): Promise<RoomDescription | null> {
    await this.load();
    const room = this.room;
    if (!room || room.epoch !== input.expectedEpoch) return null;
    room.epoch = input.newEpoch;
    room.canonicalPath = input.canonicalPath;
    room.expectedRemoteETag = input.etag;
    room.baseContentHash = input.contentHash;
    // The new path holds a revision this room just created, so nothing about it is tombstoned.
    room.replaceTombstoned = false;
    room.state = "active";
    room.pendingTarget = null;
    room.dirtySince = null;
    room.retryAttempts = 0;
    room.nextAttemptAt = null;
    room.lastError = null;
    // The rename is itself a checkpoint of this revision: the bytes now live at the new path.
    room.latestCheckpointedRevision = room.latestAcceptedRevision;
    this.persist();
    await this.ctx.storage.deleteAlarm();
    return this.describeInternal();
  }

  /**
   * Undoes a quiesce that could not complete.
   *
   * A rename whose target turned out to be taken, or a delete whose R2 act was refused, leaves the
   * room stopped. Resuming it is the difference between "the operation failed" and "the document is
   * now unusable until someone restarts the plugin".
   */
  async resume(input: { expectedEpoch: DocumentEpoch }): Promise<RoomDescription | null> {
    await this.load();
    const room = this.room;
    if (!room || room.epoch !== input.expectedEpoch || room.state === "deleted") return null;
    if (room.state === "quiescing") {
      room.state = "active";
      this.persist();
    }
    if (room.state === "active" && room.latestAcceptedRevision > room.latestCheckpointedRevision) await this.schedule(this.now());
    return this.describeInternal();
  }

  /** The document is gone: its clients are told, and the room keeps nothing that could resurrect it. */  async retire(input: { expectedEpoch: DocumentEpoch }): Promise<boolean> {
    await this.load();
    const room = this.room;
    if (!room || room.epoch !== input.expectedEpoch) return false;
    room.state = "deleted";
    room.pendingTarget = null;
    room.dirtySince = null;
    this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ protocol: HOT_PROTOCOL_VERSION, type: "document-state", documentId: room.documentId, epoch: room.epoch, state: "deleted" });
    return true;
  }

  /**
   * Clears a conflict once a human has resolved it.
   *
   * The caller states the remote revision the resolution was made against; the room adopts it as the
   * new baseline, so the next checkpoint is conditional on the state the decision was made about
   * rather than on the state that caused the conflict.
   */
  async resolveConflict(input: { expectedEpoch: DocumentEpoch; remoteETag: string | null; contentHash: string; canonicalPath: string; replaceTombstonedRevision?: boolean; now?: number }): Promise<RoomDescription | null> {
    const now = input.now ?? Date.now();
    await this.load();
    const room = this.room;
    if (!room || room.epoch !== input.expectedEpoch) return null;
    room.state = "active";
    room.expectedRemoteETag = input.remoteETag;
    room.baseContentHash = input.contentHash;
    room.canonicalPath = input.canonicalPath;
    // "Keep local" over an externally deleted revision is the one resolution that has to replace the
    // retired revision on purpose — that is what makes it a new effective incarnation rather than a
    // resurrection the Vault would (correctly) refuse.
    room.replaceTombstoned = input.replaceTombstonedRevision === true;
    // The accepted content counts as *uncheckpointed* again: the user just decided that local wins, and
    // the only way that decision reaches R2 is a checkpoint against the precondition we just re-pointed.
    // Leaving `latestCheckpointedRevision` alone would make the room consider itself saved while R2 still
    // holds the bytes that lost.
    room.pendingTarget = null;
    room.retryAttempts = 0;
    room.nextAttemptAt = null;
    room.lastError = null;
    room.dirtySince = now;
    this.persist();
    this.broadcast({ protocol: HOT_PROTOCOL_VERSION, type: "document-state", documentId: room.documentId, epoch: room.epoch, state: "active", canonicalPath: room.canonicalPath, reason: "resolved" });
    // The decision is explicit and the user is waiting for it to land, so the checkpoint starts now
    // rather than after the ordinary debounce.
    await this.schedule(now);
    return this.describeInternal();
  }

  /** Marks a conflict found by the Vault or by an external observation; the pending target is kept. */
  async flagConflict(reason: string): Promise<RoomDescription | null> {
    await this.load();
    const room = this.room;
    if (!room) return null;
    room.state = "conflicted";
    room.lastError = reason.slice(0, 200);
    this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ protocol: HOT_PROTOCOL_VERSION, type: "document-state", documentId: room.documentId, epoch: room.epoch, state: "conflicted", reason });
    return this.describeInternal();
  }

  /**
   * The cheap question the namespace coordinator asks before it adopts a room: what content does it
   * hold at which revision, and which revisions a joining client may legitimately be at.
   */
  async identity(): Promise<RoomDescription | null> {
    await this.load();
    return this.room ? this.describeInternal() : null;
  }

  /* --------------------------------------------------------------------------------------------
   * Operations
   * ------------------------------------------------------------------------------------------ */

  /**
   * One inbound operation, from acceptance to acknowledgement.
   *
   * The order matters: deduplicate, then fence on the epoch, then persist, and only then answer. A
   * client that has an acknowledgement is entitled to stop caring, so an acknowledgement that precedes
   * durability would be a lie the server cannot take back.
   */
  private async accept(frame: Extract<HotClientMessage, { type: "operation" }>): Promise<
    | { kind: "accepted"; revision: number; duplicate: boolean }
    | { kind: "rejected"; reason: "stale-epoch" | "unknown-document" | "quiescing" | "too-large" }
  > {
    await this.load();
    const room = this.room;
    if (!room) return { kind: "rejected", reason: "unknown-document" };
    if (frame.epoch !== room.epoch) return { kind: "rejected", reason: "stale-epoch" };
    const known = [...this.sql().exec<{ revision: number }>(
      "SELECT revision FROM operations WHERE client_id = ? AND client_operation_id = ?",
      frame.clientId,
      frame.clientOperationId,
    )];
    if (known.length > 0) return { kind: "accepted", revision: Number(known[0].revision), duplicate: true };
    if (room.state === "quiescing" || room.state === "deleted") return { kind: "rejected", reason: "quiescing" };

    const update = decodeHotPayload(frame.update);
    if (!update) return { kind: "rejected", reason: "too-large" };
    const doc = this.doc ?? new Y.Doc();
    this.doc = doc;
    try {
      Y.applyUpdate(doc, update);
    } catch {
      // An update the CRDT cannot read is the sender's problem, and it must not corrupt the room.
      return { kind: "rejected", reason: "too-large" };
    }
    if (new TextEncoder().encode(this.markdown()).byteLength > HOT_MAX_MATERIALIZED_BYTES) {
      this.reload();
      return { kind: "rejected", reason: "too-large" };
    }

    const revision = room.latestAcceptedRevision + 1;
    const now = this.now();
    try {
      this.ctx.storage.transactionSync(() => {
        this.sql().exec(
          "INSERT INTO operations (client_id, client_operation_id, revision, update_blob, received_at) VALUES (?, ?, ?, ?, ?)",
          frame.clientId,
          frame.clientOperationId,
          revision,
          toArrayBuffer(update),
          now,
        );
        room.latestAcceptedRevision = revision;
        if (room.dirtySince === null) room.dirtySince = now;
        this.persist(false);
      });
    } catch (error) {
      // Storage refused the operation, so the in-memory doc is now ahead of what is durable. Drop it
      // and rebuild on the next entry rather than answering an acknowledgement we cannot honour.
      console.error(`hot operation persist failed document=${room.documentId.slice(0, 8)} error=${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
      this.reload();
      throw error;
    }
    if (room.state === "conflicted") {
      // Editing continues to be accepted while a conflict is open — losing the user's typing would be
      // worse — but nothing is checkpointed until the conflict is resolved.
      this.persist();
      return { kind: "accepted", revision, duplicate: false };
    }
    await this.schedule(now);
    return { kind: "accepted", revision, duplicate: false };
  }

  /* --------------------------------------------------------------------------------------------
   * Checkpoint scheduling
   * ------------------------------------------------------------------------------------------ */

  /**
   * Arms the durable alarm.
   *
   * `min(now + debounce, dirtySince + maxInterval)` is the whole policy: a pause settles a revision
   * immediately, and typing that never pauses still cannot postpone the save past ten seconds. The
   * alarm is storage, not a timer, so an eviction or a deploy cannot lose it.
   */
  private async schedule(now: number): Promise<void> {
    const room = this.room;
    if (!room) return;
    let next: number;
    if (room.pendingTarget !== null) {
      next = room.nextAttemptAt !== null && room.nextAttemptAt > now ? room.nextAttemptAt : now;
    } else if (room.dirtySince === null) {
      return;
    } else {
      // Both bounds come from the same policy function the tests pin.
      next = now + hotCheckpointDelayMs(room.dirtySince, now);
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    await this.load();
    const room = this.room;
    if (!room || room.state === "deleted") return;
    // The same three conditions `buildTarget` uses. Leaving `dirtySince` out of this test was a real bug:
    // after a conflict resolution the room owes a save while having nothing newer than its last
    // checkpoint, so this branch cleared the debt without ever asking the Vault.
    if (room.pendingTarget === null && room.latestAcceptedRevision <= room.latestCheckpointedRevision && room.dirtySince === null) {
      room.dirtySince = null;
      this.persist();
      return;
    }
    await this.checkpointNow();
  }

  /** Builds the target for the current revision, if there is anything to save. */
  private async buildTarget(): Promise<RoomCheckpointTarget | null> {
    const room = this.room;
    if (!room) return null;
    // `dirtySince` is the third condition and it is not redundant: a conflict resolution can leave the
    // room with nothing newer than its last checkpoint while R2 holds a revision that *lost* the
    // decision. In that state the content is saved nowhere the room can trust, so it still owes a save.
    if (room.latestAcceptedRevision <= room.latestCheckpointedRevision && room.pendingTarget === null && room.dirtySince === null) return null;
    const revision = room.latestAcceptedRevision;
    const markdown = this.markdown();
    return {
      documentId: room.documentId,
      epoch: room.epoch,
      canonicalPath: room.canonicalPath,
      documentRevision: revision,
      contentHash: await hotContentHash(markdown),
      commitId: `${room.documentId}.${room.epoch}.${revision}`,
      expectedRemoteETag: room.expectedRemoteETag,
      createdAt: this.now(),
      attempts: 0,
      // The snapshot travels with the target so a retry after an eviction saves the revision the
      // receipt will name, not whatever the document has moved on to.
      markdown,
    };
  }

  private receiptFor(target: RoomCheckpointTarget, etag: string | null): CheckpointReceipt {
    const room = this.room!;
    return {
      protocol: HOT_PROTOCOL_VERSION,
      type: "checkpoint",
      documentId: room.documentId,
      epoch: room.epoch,
      canonicalPath: target.canonicalPath,
      documentRevision: target.documentRevision,
      contentHash: target.contentHash,
      r2ETag: etag,
      commitId: target.commitId,
      latestAcceptedRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      checkpointedAt: this.now(),
    };
  }

  /**
   * Runs one checkpoint to completion, or to a state the caller can act on.
   *
   * Returns `null` when R2 did not accept the revision (retry scheduled, or conflict raised), and the
   * receipt when it did. The revision named by the receipt is the target's, never "the latest": a
   * document that produced V43 while V42 was in flight must not report V43 as saved.
   */
  private async checkpointNow(except?: WebSocket): Promise<CheckpointReceipt | null> {
    const room = this.room;
    if (!room) return null;
    if (room.state === "deleted" || room.state === "conflicted") return null;
    const vault = this.vault();
    if (!vault) {
      room.lastError = "vault-binding-missing";
      this.persist();
      return null;
    }

    let target = room.pendingTarget ?? await this.buildTarget();
    if (!target) return null;
    if (room.pendingTarget === null) {
      room.pendingTarget = target;
      room.retryAttempts = 0;
      room.nextAttemptAt = null;
      this.persist();
    }

    let result: HotCheckpointResult;
    try {
      result = await vault.checkpointHotDocument({
        canonicalPath: target.canonicalPath,
        documentId: target.documentId,
        epoch: target.epoch,
        documentRevision: target.documentRevision,
        commitId: target.commitId,
        contentHash: target.contentHash,
        markdown: target.markdown,
        expectedRemoteETag: target.expectedRemoteETag,
        replaceTombstonedRevision: room.replaceTombstoned,
      });
    } catch (error) {
      result = { status: "failed", reason: "unavailable", detail: error instanceof Error ? error.message.slice(0, 160) : "unknown" };
    }

    if (result.status === "committed") {
      room.latestCheckpointedRevision = Math.max(room.latestCheckpointedRevision, target.documentRevision);
      room.baseContentHash = target.contentHash;
      room.expectedRemoteETag = result.etag;
      room.pendingTarget = null;
      room.retryAttempts = 0;
      room.nextAttemptAt = null;
      room.lastError = null;
      room.dirtySince = room.latestAcceptedRevision > room.latestCheckpointedRevision ? this.now() : null;
      this.persist();
      await this.compact();
      const receipt = this.receiptFor(target, result.etag);
      // The requester gets exactly one receipt: the broadcast skips it and the caller sends the copy.
      // A duplicated receipt is not harmless — a client that counts receipts would think a revision it
      // never requested had also been saved.
      this.broadcast(receipt, except);
      if (room.dirtySince !== null) await this.schedule(this.now());
      else await this.ctx.storage.deleteAlarm();
      return receipt;
    }

    if (result.status === "conflict") {
      room.state = "conflicted";
      room.lastError = `${result.reason}`;
      room.pendingTarget = target;
      this.persist();
      await this.ctx.storage.deleteAlarm();
      this.broadcast({ protocol: HOT_PROTOCOL_VERSION, type: "document-state", documentId: room.documentId, epoch: room.epoch, state: "conflicted", reason: result.reason, canonicalPath: room.canonicalPath }, except);
      return null;
    }

    // A failure is never reported as a save. The target stays durable and the alarm is re-armed with
    // backoff, because the platform's own limited retries are not a durability story.
    const attempts = room.retryAttempts + 1;
    room.retryAttempts = attempts;
    room.pendingTarget = target;
    room.lastError = result.detail ?? result.reason;
    room.nextAttemptAt = this.now() + Math.min(HOT_RETRY_CAP_MS, HOT_RETRY_BASE_MS * 2 ** Math.min(attempts, 5));
    this.persist();
    await this.ctx.storage.setAlarm(room.nextAttemptAt);
    return null;
  }

  /**
   * Folds the operation log into the snapshot.
   *
   * Only *after* a successful checkpoint: the log is the recovery path for revisions that are not in
   * R2 yet, so compacting past them would trade a durable fact for storage.
   */
  private async compact(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const rows = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations WHERE revision <= ?", room.latestCheckpointedRevision)];
    if (Number(rows[0]?.count ?? 0) < COMPACTION_OPERATION_LIMIT) return;
    const snapshot = Y.encodeStateAsUpdate(this.doc ?? new Y.Doc());
    const snapshotRevision = room.latestAcceptedRevision;
    this.ctx.storage.transactionSync(() => {
      this.sql().exec("UPDATE room SET snapshot = ?, snapshot_revision = ? WHERE id = 1", snapshot, snapshotRevision);
      this.sql().exec("DELETE FROM operations WHERE revision <= ?", snapshotRevision);
    });
    room.snapshotRevision = snapshotRevision;
  }

  /** The revision a requesting client needs covered, checkpointed now. */
  async requestCheckpoint(input: { upToRevision: number }): Promise<{ receipt: CheckpointReceipt | null; pendingSave: boolean }> {
    await this.load();
    const room = this.room;
    if (!room) return { receipt: null, pendingSave: false };
    const receipt = await this.checkpointNow();
    return { receipt, pendingSave: room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null };
  }

  /** The checkpoint the Vault accepted most recently, for a client that lost the broadcast. */
  async lastReceipt(): Promise<CheckpointReceipt | null> {
    await this.load();
    const room = this.room;
    if (!room || room.latestCheckpointedRevision === 0) return null;
    return {
      protocol: HOT_PROTOCOL_VERSION,
      type: "checkpoint",
      documentId: room.documentId,
      epoch: room.epoch,
      canonicalPath: room.canonicalPath,
      documentRevision: room.latestCheckpointedRevision,
      contentHash: room.baseContentHash,
      r2ETag: room.expectedRemoteETag,
      commitId: `${room.documentId}.${room.epoch}.${room.latestCheckpointedRevision}`,
      latestAcceptedRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      checkpointedAt: this.now(),
    };
  }

  /* --------------------------------------------------------------------------------------------
   * Sockets
   * ------------------------------------------------------------------------------------------ */

  private broadcast(message: unknown, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try { socket.send(payload); } catch { try { socket.close(1011, "send failed"); } catch {} }
    }
  }

  private send(socket: WebSocket, message: unknown): void {
    try { socket.send(JSON.stringify(message)); } catch { /* the close handler owns cleanup */ }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/session") return new Response(null, { status: 404 });
    const clientId = request.headers.get("X-Hot-Client") ?? "";
    const epoch = Number(request.headers.get("X-Hot-Epoch") ?? "0");
    await this.load();
    const room = this.room;
    if (!room) return new Response("unknown document", { status: 404 });
    if (room.epoch !== epoch) return new Response("stale epoch", { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientId, epoch });
    this.sql().exec(
      "INSERT INTO clients (client_id, joined_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
      clientId,
      this.now(),
      this.now(),
    );
    this.send(server, {
      protocol: HOT_PROTOCOL_VERSION,
      type: "welcome",
      documentId: room.documentId,
      epoch: room.epoch,
      canonicalPath: room.canonicalPath,
      state: room.state,
      serverRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      crdtState: encodeHotPayload(Y.encodeStateAsUpdate(this.doc ?? new Y.Doc())),
      pendingSave: room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null,
    });
    return new Response(null, { status: 101, webSocket: client, headers: { "Cache-Control": "no-store" } });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.load();
    const room = this.room;
    if (!room) { this.send(socket, { protocol: HOT_PROTOCOL_VERSION, type: "error", code: "unknown-document" }); return; }
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
    } catch {
      this.send(socket, { protocol: HOT_PROTOCOL_VERSION, type: "error", code: "malformed" });
      return;
    }
    const frame = parseHotClientMessage(parsed);
    if (!frame) { this.send(socket, { protocol: HOT_PROTOCOL_VERSION, type: "error", code: "malformed" }); return; }
    // A keepalive is answered by the runtime at the protocol level; it needs no room state.
    if (frame.type === "ping") return;

    const attachment = socket.deserializeAttachment() as { clientId?: string } | null;
    const clientId = attachment?.clientId ?? frame.clientId;
    if (frame.type === "operation" && frame.clientId !== clientId) {
      this.send(socket, { protocol: HOT_PROTOCOL_VERSION, type: "reject", documentId: frame.documentId, epoch: frame.epoch, clientOperationId: frame.clientOperationId, reason: "unauthorized" });
      return;
    }

    if (frame.type === "operation") {
      const outcome = await this.accept(frame);
      if (outcome.kind === "rejected") {
        this.send(socket, { protocol: HOT_PROTOCOL_VERSION, type: "reject", documentId: frame.documentId, epoch: frame.epoch, clientOperationId: frame.clientOperationId, reason: outcome.reason });
        return;
      }
      if (!outcome.duplicate) {
        const broadcast: HotServerOperation = { ...frame, serverRevision: outcome.revision };
        this.broadcast(broadcast, socket);
      }
      this.send(socket, {
        protocol: HOT_PROTOCOL_VERSION,
        type: "ack",
        documentId: room.documentId,
        epoch: room.epoch,
        clientOperationId: frame.clientOperationId,
        serverRevision: outcome.revision,
        duplicate: outcome.duplicate,
      });
      return;
    }

    if (frame.type === "checkpoint-request") {
      const receipt = await this.checkpointNow(socket);
      if (receipt) {
        this.send(socket, receipt);
        return;
      }
      // Every request gets exactly one answer that says what happened. A requester whose checkpoint
      // failed must be told *why* — silently answering with an older receipt, or with nothing at all,
      // is how a client comes to believe a save happened that did not.
      const pending = room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null;
      if (!pending && room.state === "active") {
        const last = await this.lastReceipt();
        if (last) {
          this.send(socket, last);
          return;
        }
      }
      this.send(socket, {
        protocol: HOT_PROTOCOL_VERSION,
        type: "document-state",
        documentId: room.documentId,
        epoch: room.epoch,
        state: room.state,
        reason: room.lastError ?? (pending ? "checkpoint-pending" : "nothing-to-save"),
        canonicalPath: room.canonicalPath,
      });
      return;
    }

    if (frame.type === "leave") {
      this.sql().exec("DELETE FROM clients WHERE client_id = ?", clientId);
      if (frame.checkpoint) await this.checkpointNow();
      const remaining = this.ctx.getWebSockets().filter(candidate => candidate !== socket).length;
      if (remaining === 0) {
        // The last owner walked away on purpose. This is the moment the design promises a final
        // checkpoint, and it happens on the server, not on a client that may never come back.
        await this.checkpointNow();
        await this.handBackOwnership();
      }
      try { socket.close(1000, "left"); } catch { /* already closing */ }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.load();
    const attachment = socket.deserializeAttachment() as { clientId?: string } | null;
    if (attachment?.clientId) this.sql().exec("DELETE FROM clients WHERE client_id = ?", attachment.clientId);
    const remaining = this.ctx.getWebSockets().filter(candidate => candidate !== socket).length;
    const room = this.room;
    if (remaining === 0 && room && room.state === "active") {
      // An abrupt disconnect still owes the vault a save: the server has already acknowledged these
      // operations, so "the client is gone" may not mean "the edit is gone".
      await this.checkpointNow();
      await this.handBackOwnership();
    }
  }

  /**
   * Tells the namespace that nobody is holding this document any more.
   *
   * Ownership is what fences cold writers, and a room whose last client vanished is the one component
   * that knows the session ended *without* the client saying so. Without this the path would stay
   * fenced until the claim's grace period expired, which turns a killed laptop into a minute of
   * "this file is busy" for every other device.
   */
  private async handBackOwnership(): Promise<void> {
    const room = this.room;
    if (!room || !room.channel) return;
    if (room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null) return;
    const coordinator = this.coordinator();
    if (!coordinator) return;
    try {
      await coordinator.getByName(room.channel).releaseOwnership({ documentId: room.documentId, epoch: room.epoch });
    } catch {
      // The claim expires on its own; an unhanded-back path is a delay, not a correctness problem, and
      // a failed notification must not fail the socket close that triggered it.
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /** Client reference counts, as the coordinator needs them: one client, many panes, one entry. */
  async clientCount(): Promise<number> {
    await this.load();
    const rows = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM clients")];
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * One client leaving on purpose.
   *
   * The client count is taken *after* this client is removed, which is the whole point: a device that
   * asks to be released is asking whether the path is free, and counting itself would make the answer
   * permanently "no". When the last owner leaves, the room checkpoints and hands the path back to the
   * namespace in the same call, so the client does not have to poll for its own departure.
   */
  async releaseClient(input: { clientId: string; epoch: DocumentEpoch; checkpoint: boolean; lastAcceptedRevision: number }): Promise<{
    outcome: "released" | "checkpoint-pending" | "not-owner";
    remainingClients: number;
    latestAcceptedRevision: number;
    latestCheckpointedRevision: number;
    receipt: CheckpointReceipt | null;
    pendingSave: boolean;
  }> {
    await this.load();
    const room = this.room;
    if (!room || room.epoch !== input.epoch) return { outcome: "not-owner", remainingClients: 0, latestAcceptedRevision: 0, latestCheckpointedRevision: 0, receipt: null, pendingSave: false };
    this.sql().exec("DELETE FROM clients WHERE client_id = ?", input.clientId);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { clientId?: string } | null;
      if (attachment?.clientId === input.clientId) {
        try { socket.close(1000, "released"); } catch { /* already closing */ }
      }
    }
    const wanted = input.checkpoint || room.latestAcceptedRevision > room.latestCheckpointedRevision;
    const receipt = wanted ? await this.checkpointNow() : await this.lastReceipt();
    const remaining = await this.clientCount();
    if (remaining === 0) {
      // The final checkpoint and the ownership hand-back belong to the last owner leaving, not to a
      // timer: a device that closed the document is exactly when the design promises a save.
      await this.checkpointNow();
      await this.handBackOwnership();
    }
    const pendingSave = room.pendingTarget !== null || room.latestAcceptedRevision > room.latestCheckpointedRevision || room.dirtySince !== null;
    return {
      outcome: receipt !== null || !pendingSave ? "released" : "checkpoint-pending",
      remainingClients: remaining,
      latestAcceptedRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      receipt: receipt ?? null,
      pendingSave,
    };
  }

  /** Whether this room's namespace transition is still pending, so a retry must resume rather than repeat. */
  async checkpointState(): Promise<{ pendingTarget: RoomCheckpointTarget | null; state: HotRoomState; epoch: DocumentEpoch } | null> {
    await this.load();
    const room = this.room;
    if (!room) return null;
    return { pendingTarget: room.pendingTarget, state: room.state, epoch: room.epoch };
  }

  /**
   * Aggregate storage state: counts and revisions only, never content.
   *
   * It exists because "the room compacts its log" is a durability claim, and a claim about storage that
   * cannot be observed is not one an operator can check. `operations` is what a crash has to replay;
   * once `snapshotRevision` catches up with `latestCheckpointedRevision`, the log's surviving rows are
   * exactly the revisions R2 does not have yet.
   */
  async storageStats(): Promise<{ operations: number; snapshotRevision: number; latestAcceptedRevision: number; latestCheckpointedRevision: number; pendingTargetRevision: number | null; alarmAt: number | null } | null> {
    await this.load();
    const room = this.room;
    if (!room) return null;
    const rows = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")];
    return {
      operations: Number(rows[0]?.count ?? 0),
      snapshotRevision: room.snapshotRevision,
      latestAcceptedRevision: room.latestAcceptedRevision,
      latestCheckpointedRevision: room.latestCheckpointedRevision,
      pendingTargetRevision: room.pendingTarget?.documentRevision ?? null,
      // When the room intends to save next. It is the observable form of the debounce/cap policy, and
      // the operator's answer to "why has this document not reached R2 yet".
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }
}

/** The coordinator, as this object needs it: one method, addressed by knowledge base. */
export type CoordinatorSurface = {
  releaseOwnership(input: { documentId: string; epoch: DocumentEpoch }): Promise<boolean>;
};

/** The bindings this object needs; declared here so the Gateway env stays the single source of truth. */
export type GatewayHotEnv = {
  VAULT?: unknown;
  COORDINATOR?: { getByName(name: string): CoordinatorSurface };
};

type RoomRow = {
  documentId: string;
  epoch: DocumentEpoch;
  canonicalPath: string;
  state: HotRoomState;
  latestAcceptedRevision: number;
  latestCheckpointedRevision: number;
  expectedRemoteETag: string | null;
  baseContentHash: string;
  channel: string;
  /** `true` when this room was created over a tombstoned revision, so replacing it is the intent. */
  replaceTombstoned: boolean;
  snapshotRevision: number;
  pendingTarget: RoomCheckpointTarget | null;
  dirtySince: number | null;
  retryAttempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

/**
 * The persisted row, exactly as SQLite speaks it.
 *
 * Values are the column names and the storage primitives, because that is what `SqlStorage.exec`
 * can hand back; the camel-cased `RoomRow` above is the in-memory shape and is built from this one in
 * a single place, so there is exactly one translation to get wrong.
 */
type RoomDbRow = {
  document_id: string;
  epoch: number;
  canonical_path: string;
  state: string;
  latest_accepted_revision: number;
  latest_checkpointed_revision: number;
  expected_remote_etag: string | null;
  base_content_hash: string;
  channel: string;
  replace_tombstoned: number;
  snapshot: ArrayBuffer;
  snapshot_revision: number;
  pending_target: string | null;
  dirty_since: number | null;
  retry_attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
};

/**
 * A pending checkpoint.
 *
 * The Markdown travels with the target because the target names a *specific* revision: after an
 * eviction or a retry, the room must save the bytes that revision produced, not whatever the document
 * has since become.
 */
export type RoomCheckpointTarget = CheckpointTarget & { markdown: string };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesOf(value: ArrayBuffer | Uint8Array | null | undefined): Uint8Array {
  if (!value) return new Uint8Array();
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function parseTarget(value: unknown): RoomCheckpointTarget | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as RoomCheckpointTarget;
    return typeof parsed.markdown === "string" && typeof parsed.documentRevision === "number" ? parsed : null;
  } catch {
    return null;
  }
}


