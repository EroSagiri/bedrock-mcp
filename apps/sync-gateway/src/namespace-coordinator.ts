import { DurableObject } from "cloudflare:workers";
import type { HotDeleteResult, HotMoveResult, HotPathObservation, VaultHotRpc } from "@mineral/core/vault-rpc";
import {
  HOT_PROTOCOL_VERSION,
  type ColdAuthorityCommit,
  type ColdAuthorityRequest,
  type ColdAuthorityResult,
  type DocumentEpoch,
  type HotAcquireRequest,
  type HotAcquireResult,
  type HotReleaseRequest,
  type HotReleaseResult,
  type HotRemoteObservation,
  type PathBinding,
  type PathBindingState,
} from "@mineral/sync-core/hot-protocol";
import {
  NAMESPACE_PROTOCOL_VERSION,
  isNamespaceIntent,
  type NamespaceIntent,
  type NamespaceOperationRecord,
  type NamespaceOutcome,
  type NamespacePhase,
  type NamespaceReason,
  type NamespaceResult,
} from "@mineral/sync-core/namespace-protocol";
import { canonicalVaultPath } from "@mineral/sync-core/paths";
import type { LiveDocumentRoom, RoomDescription } from "./live-document-room";

/**
 * NamespaceCoordinator — one path namespace per knowledge base (Phase Hot-C).
 *
 * Knowledge-base scoped rather than per path, deliberately: a rename must validate the source binding
 * and the target's availability *together* and then change both, and two independently-owned objects
 * would turn every rename into a distributed transaction between them. One object per knowledge base
 * makes the pair of checks and the pair of writes a single-threaded sequence.
 *
 * It owns:
 *
 * - path bindings: which document incarnation a path currently addresses,
 * - epochs: the fence that makes a pre-rename message unapplyable after the rename,
 * - the three lifecycle operations, as durable and idempotent state machines,
 * - the decision the cold path needs: may this path be cold-mutated right now?
 *
 * It owns no content. It never reads or writes Markdown: the room checkpoints, the Vault writes R2,
 * and this object records only what the namespace became.
 */

/** How long a cold-mutation lease is valid; mirrors the wire constant. */
const COLD_LEASE_TTL_MS = 30_000;
/**
 * How long a hot claim survives with no live session.
 *
 * A killed client cannot send a release. The claim exists so a cold writer is fenced while the room is
 * live, and it expires so a claim nobody will ever clear cannot fence the path forever.
 */
const OWNERSHIP_IDLE_TTL_MS = 60_000;
/** How soon an unfinished namespace operation is retried by the object itself. */
const NAMESPACE_RESUME_MS = 5_000;
/** Bounded on purpose: a client that is gone must produce a failure, not an infinite retry. */
const MAX_NAMESPACE_RESUME_ATTEMPTS = 6;

type BindingRow = {
  canonical_path: string;
  document_id: string | null;
  epoch: number;
  state: string;
  updated_at: number;
};

type OperationRow = {
  operation_id: string;
  type: string;
  phase: string;
  canonical_path: string;
  from_path: string | null;
  document_id: string | null;
  epoch: number | null;
  intent: string;
  result: string | null;
  updated_at: number;
};

type LeaseRow = {
  token: string;
  canonical_path: string;
  client_id: string;
  operation_id: string;
  operation: string;
  expected_remote_etag: string | null;
  expires_at: number;
};

export type ColdCommitOutcome = {
  outcome: "recorded" | "raced" | "unknown-lease" | "expired";
  canonicalPath: string;
  binding: PathBinding | null;
  remote: HotRemoteObservation | null;
  /** `true` when a hot session exists for the path, so the cold write and the room may collide. */
  hotOwned: boolean;
};

export type GatewayNamespaceEnv = {
  VAULT?: unknown;
  ROOM?: DurableObjectNamespace<LiveDocumentRoom>;
};

export class NamespaceCoordinator extends DurableObject<GatewayNamespaceEnv> {
  constructor(ctx: DurableObjectState, env: GatewayNamespaceEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.schema();
    });
  }

  /** The Vault and the room, as overridable seams for the test deployment. */
  protected vault(): VaultHotRpc | undefined {
    return this.env.VAULT as unknown as VaultHotRpc | undefined;
  }

  protected room(documentId: string): DurableObjectStub<LiveDocumentRoom> | undefined {
    return this.env.ROOM?.getByName(documentId);
  }

  private sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private schema(): void {
    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS path_bindings (
        canonical_path TEXT PRIMARY KEY,
        document_id TEXT,
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS path_bindings_document ON path_bindings(document_id);
      CREATE TABLE IF NOT EXISTS namespace_ops (
        operation_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        phase TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        from_path TEXT,
        document_id TEXT,
        epoch INTEGER,
        intent TEXT NOT NULL,
        result TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cold_leases (
        token TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        client_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        expected_remote_etag TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cold_leases_expiry ON cold_leases(expires_at);
      CREATE TABLE IF NOT EXISTS hot_ownership (
        canonical_path TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL
      );
    `);
    // A resume counter, added after the fact: an operation that a client walked away from must be
    // retried a bounded number of times and then *fail*, rather than being retried forever or leaving
    // its path quiescing forever.
    try {
      this.sql().exec("ALTER TABLE namespace_ops ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0");
    } catch { /* already there */ }
  }

  private now(): number {
    return Date.now();
  }

  /**
   * This object's own name: the knowledge base it coordinates.
   *
   * It is read from the object id rather than passed in on every call, because every room it creates
   * has to be told which namespace to report back to, and a caller-supplied channel would be a second
   * source of truth for the one value that scopes all authorization.
   */
  private knowledgeBaseId(): string {
    return this.ctx.id.name ?? "";
  }

  /* --------------------------------------------------------------------------------------------
   * Bindings
   * ------------------------------------------------------------------------------------------ */

  private bindingRow(path: string): BindingRow | null {
    return [...this.sql().exec<BindingRow>("SELECT * FROM path_bindings WHERE canonical_path = ?", path)][0] ?? null;
  }

  private toBinding(row: BindingRow): PathBinding {
    return {
      canonicalPath: row.canonical_path,
      documentId: row.document_id === null ? null : String(row.document_id),
      epoch: Number(row.epoch),
      state: String(row.state) as PathBindingState,
      updatedAt: Number(row.updated_at),
    };
  }

  async binding(input: { canonicalPath: string }): Promise<PathBinding | null> {
    const path = canonicalVaultPath(input?.canonicalPath);
    if (!path) return null;
    const row = this.bindingRow(path);
    return row ? this.toBinding(row) : null;
  }

  private putBinding(binding: PathBinding): void {
    this.sql().exec(
      `INSERT INTO path_bindings (canonical_path, document_id, epoch, state, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(canonical_path) DO UPDATE SET document_id = excluded.document_id, epoch = excluded.epoch, state = excluded.state, updated_at = excluded.updated_at`,
      binding.canonicalPath,
      binding.documentId,
      binding.epoch,
      binding.state,
      binding.updatedAt,
    );
  }

  private setBindingState(path: string, state: PathBindingState): void {
    const row = this.bindingRow(path);
    if (!row) return;
    this.putBinding({ ...this.toBinding(row), state, updatedAt: this.now() });
  }

  /* --------------------------------------------------------------------------------------------
   * Observation and ownership
   * ------------------------------------------------------------------------------------------ */

  private async observe(path: string, withContent: boolean): Promise<HotPathObservation | null> {
    const vault = this.vault();
    if (!vault) return null;
    try {
      return await vault.observeHotPath({ canonicalPath: path, withContent });
    } catch {
      return null;
    }
  }

  /**
   * Whether a hot session currently forbids cold mutation of this path.
   *
   * The binding alone cannot answer it: a path keeps its binding after the session ends, because that
   * is how a later hot open finds its history again. "Hot" means *the room is live* — a connected
   * client, a save it still owes, or a namespace transition in flight. An idle, fully checkpointed
   * room has handed the path back and a cold writer is allowed to take it.
   */
  private async ownership(path: string): Promise<{ owned: boolean; description: RoomDescription | null; binding: PathBinding | null }> {
    const row = this.bindingRow(path);
    if (!row) return { owned: false, description: null, binding: null };
    const binding = this.toBinding(row);
    if (binding.state === "deleted" || !binding.documentId) return { owned: false, description: null, binding };
    const room = this.room(binding.documentId);
    const description = room ? await room.identity().catch(() => null) : null;
    if (!description) return { owned: false, description: null, binding };

    const live = description.clients > 0 || description.pendingSave;
    if (live) return { owned: true, description, binding };
    if (description.state === "quiescing" || description.state === "conflicted") return { owned: true, description, binding };
    if (description.state === "deleted") return { owned: false, description, binding };

    // Idle and checkpointed. A claim that is still fresh is respected, because its client may be in
    // the middle of the handoff; anything older is stale state nobody will ever clear.
    const claims = [...this.sql().exec<{ acquired_at: number }>("SELECT acquired_at FROM hot_ownership WHERE canonical_path = ?", path)];
    if (claims.length === 0) return { owned: false, description, binding };
    if (this.now() - Number(claims[0].acquired_at) < OWNERSHIP_IDLE_TTL_MS) return { owned: true, description, binding };
    this.sql().exec("DELETE FROM hot_ownership WHERE canonical_path = ?", path);
    return { owned: false, description, binding };
  }

  private claimOwnership(path: string, documentId: string, epoch: DocumentEpoch): void {
    this.sql().exec(
      "INSERT INTO hot_ownership (canonical_path, document_id, epoch, acquired_at) VALUES (?, ?, ?, ?) ON CONFLICT(canonical_path) DO UPDATE SET document_id = excluded.document_id, epoch = excluded.epoch, acquired_at = excluded.acquired_at",
      path,
      documentId,
      epoch,
      this.now(),
    );
  }

  /**
   * Releases a hot claim, but only when the room agrees it is finished.
   *
   * This is the server-side mirror of the client's handoff. Until the last checkpoint has landed with
   * no client connected and nothing pending, the path stays fenced — a save the server still owes must
   * not be overwritten by a cold writer that believes the file is idle.
   */
  async releaseOwnership(input: { documentId: string; epoch: DocumentEpoch }): Promise<boolean> {
    const room = this.room(input.documentId);
    const description = room ? await room.identity().catch(() => null) : null;
    if (description && (description.clients > 0 || description.pendingSave || description.state === "quiescing" || description.state === "conflicted")) return false;
    const rows = [...this.sql().exec<{ canonical_path: string; epoch: number }>("SELECT canonical_path, epoch FROM hot_ownership WHERE document_id = ?", input.documentId)];
    let released = false;
    for (const row of rows) {
      if (Number(row.epoch) !== input.epoch) continue;
      this.sql().exec("DELETE FROM hot_ownership WHERE canonical_path = ?", String(row.canonical_path));
      released = true;
    }
    return released;
  }

  /* --------------------------------------------------------------------------------------------
   * Acquisition
   * ------------------------------------------------------------------------------------------ */

  /**
   * Adopts a path into a hot session, or refuses with a reason the client can act on.
   *
   * The refusals are the interesting half: "the remote changed", "your local file is not a version
   * this room knows", "someone else already bound this path" are answers the plugin can reconcile
   * deliberately. Seeding the room from whichever side arrived first is what turns a collaboration
   * feature into data loss.
   */
  async acquire(input: HotAcquireRequest): Promise<HotAcquireResult> {
    const path = canonicalVaultPath(input.canonicalPath);
    if (!path) return this.rejected("invalid", typeof input.canonicalPath === "string" ? input.canonicalPath : "");
    const row = this.bindingRow(path);
    const binding = row ? this.toBinding(row) : null;
    const active = binding && binding.state === "active" && binding.documentId ? binding : null;

    if (input.expected.state === "absent" && active) return this.conflictResult(path, active, null, "path-taken");
    if (input.expected.state === "bound") {
      if (!active) return this.conflictResult(path, binding, null, "binding-changed");
      if (active.documentId !== input.expected.documentId || active.epoch !== input.expected.epoch) {
        return this.conflictResult(path, active, null, active.epoch !== input.expected.epoch ? "stale-epoch" : "binding-changed");
      }
    }
    // A path whose incarnation is mid-transition is not adoptable, and it is certainly not free.
    if (binding && (binding.state === "quiescing" || binding.state === "conflicted")) {
      return this.conflictResult(path, binding, null, binding.state === "quiescing" ? "quiescing" : "remote-changed");
    }

    const observation = await this.observe(path, input.wantSession);
    if (!observation) return this.rejected("unavailable", path);
    const remote = observation.observation;

    if (active) return this.joinOrAdopt(input, path, active, observation);

    // No live incarnation. R2 content becomes the new incarnation's baseline; a path that is
    // effectively absent but still holds a tombstoned revision is the second case, which is why the
    // room's precondition is the *physical* etag and never "nothing exists".
    if (remote.exists) {
      if (input.local && remote.contentHash && input.local.contentHash !== remote.contentHash) {
        return this.conflictResult(path, null, remote, "local-remote-mismatch");
      }
      if (observation.content === undefined || !remote.etag) return this.rejected("unavailable", path);
      return this.createIncarnation(input, path, { content: observation.content, etag: remote.etag }, remote);
    }
    return this.createIncarnation(input, path, null, remote);
  }

  private async joinOrAdopt(input: HotAcquireRequest, path: string, binding: PathBinding, observation: HotPathObservation): Promise<HotAcquireResult> {
    const room = this.room(binding.documentId!);
    if (!room) return this.rejected("unavailable", path);
    const description = await room.identity().catch(() => null);
    const remote = observation.observation;

    if (!description) {
      // A binding without a room is the crash window between "the binding was written" and "the room
      // was bootstrapped". Recovery adopts the authoritative content again under the *same* document
      // id: the identity was already promised to clients, and minting a new one would invalidate every
      // baseline that mentions it.
      if (!remote.exists) return this.conflictResult(path, binding, remote, "remote-deleted");
      if (input.local && remote.contentHash && input.local.contentHash !== remote.contentHash) return this.conflictResult(path, binding, remote, "local-remote-mismatch");
      if (observation.content === undefined || !remote.etag) return this.rejected("unavailable", path);
      const bootstrapped = await room.bootstrap({ documentId: binding.documentId!, epoch: binding.epoch, canonicalPath: path, channel: this.knowledgeBaseId(), seed: { content: observation.content, etag: remote.etag }, expectedRemoteETag: remote.etag, replaceTombstonedRevision: false });
      if (input.wantSession) this.claimOwnership(path, bootstrapped.documentId, bootstrapped.epoch);
      return this.joined(path, binding, remote, bootstrapped);
    }
    if (description.epoch !== binding.epoch) {
      // The room is authoritative about its own epoch; a stale binding is repaired rather than
      // refusing a client that did nothing wrong.
      binding = { ...binding, epoch: description.epoch, updatedAt: this.now() };
      this.putBinding(binding);
    }
    if (description.state === "conflicted") return this.conflictResult(path, binding, remote, "remote-changed");
    if (description.state !== "active") return this.conflictResult(path, binding, remote, "quiescing");

    const live = description.clients > 0 || description.pendingSave;
    if (!live) {
      // Nobody holds the document, so the only question is whether R2 still matches what this room
      // last published. "Stale" means *R2 moved*, not "R2 is empty": a room that has never
      // checkpointed expects a free path, and treating that absence as staleness would mint a fresh
      // incarnation every time a second client opened the file before the first one connected.
      const checkpointed = description.latestCheckpointedRevision > 0;
      const stale = checkpointed
        ? (description.expectedRemoteETag ?? null) !== (remote.etag ?? null)
        : remote.etag !== null;
      if (stale) {
        if (!checkpointed && description.latestAcceptedRevision > 0) {
          // The path was free when this incarnation was bound, its clients have already produced
          // revisions, and something else has since put content there. Dropping those revisions is not
          // this layer's decision to make.
          return this.conflictResult(path, binding, remote, "remote-changed");
        }
        if (remote.exists) {
          if (input.local && remote.contentHash && input.local.contentHash !== remote.contentHash) return this.conflictResult(path, binding, remote, "local-remote-mismatch");
          if (observation.content === undefined || !remote.etag) return this.rejected("unavailable", path);
          return this.createIncarnation(input, path, { content: observation.content, etag: remote.etag }, remote);
        }
        if (input.local && input.local.contentHash && input.local.contentHash !== emptyContentHash()) {
          // Gone remotely, still present locally: that is a delete-versus-local conflict, not a
          // brand-new document.
          return this.conflictResult(path, binding, remote, "remote-deleted");
        }
        // A completed deletion (or a lost revision) with nothing local to protect: a new incarnation,
        // which is the same answer a recreate gets.
        return this.createIncarnation(input, path, null, remote);
      }
    }

    // A client whose local file is *empty* has nothing to protect, so it is not a disagreement: the
    // document's revision is simply content it has not downloaded yet. Refusing this join was how an empty
    // file — a freshly created note, or a device that never received the content — ended up in a conflict
    // it could only clear by hand.
    const hasLocalContent = Boolean(input.local && input.local.contentHash && input.local.contentHash !== emptyContentHash());
    if (hasLocalContent && description.currentContentHash && description.baseContentHash) {
      const known = input.local!.contentHash === description.currentContentHash || input.local!.contentHash === description.baseContentHash;
      if (!known) return this.conflictResult(path, binding, remote, "local-remote-mismatch");
    }
    if (input.wantSession) this.claimOwnership(path, binding.documentId!, binding.epoch);
    return this.joined(path, binding, remote, description);
  }

  private joined(path: string, binding: PathBinding, remote: HotRemoteObservation, description: RoomDescription): HotAcquireResult {
    return {
      protocol: HOT_PROTOCOL_VERSION,
      outcome: "joined",
      canonicalPath: path,
      binding,
      remote,
      identity: { documentId: description.documentId, epoch: description.epoch },
      serverRevision: description.latestAcceptedRevision,
      latestCheckpointedRevision: description.latestCheckpointedRevision,
      roomState: description.state,
    };
  }

  /** Allocates a fresh incarnation and binds it. `seed` is the authoritative baseline, when one exists. */
  private async createIncarnation(input: { clientId: string; local: { contentHash: string; size: number } | null; wantSession: boolean }, path: string, seed: { content: string; etag: string } | null, remote: HotRemoteObservation): Promise<HotAcquireResult> {
    const documentId = newDocumentId();
    const epoch: DocumentEpoch = 1;
    const room = this.room(documentId);
    if (!room) return this.rejected("unavailable", path);
    const binding: PathBinding = { canonicalPath: path, documentId, epoch, state: "active", updatedAt: this.now() };
    this.putBinding(binding);
    const description = await room.bootstrap({
      documentId,
      epoch,
      canonicalPath: path,
      channel: this.knowledgeBaseId(),
      seed,
      // A tombstoned path still holds a physical revision, and its replacement must be conditional on
      // *that* revision: only then does the old tombstone keep describing the object it retired.
      expectedRemoteETag: remote.etag,
      // A path whose current revision is tombstoned is exactly the recreate case: this room is a new
      // incarnation whose first checkpoint is meant to replace the retired revision.
      replaceTombstonedRevision: seed === null && remote.deleted,
    });
    if (input.wantSession) this.claimOwnership(path, documentId, epoch);
    return {
      protocol: HOT_PROTOCOL_VERSION,
      outcome: "created",
      canonicalPath: path,
      binding,
      remote,
      identity: { documentId, epoch },
      serverRevision: description.latestAcceptedRevision,
      latestCheckpointedRevision: description.latestCheckpointedRevision,
      roomState: description.state,
    };
  }

  private rejected(reason: "invalid" | "unavailable", path: string): HotAcquireResult {
    return { protocol: HOT_PROTOCOL_VERSION, outcome: "rejected", reason, canonicalPath: path, binding: null, remote: null };
  }

  private conflictResult(path: string, binding: PathBinding | null, remote: HotRemoteObservation | null, reason: HotAcquireResult["reason"]): HotAcquireResult {
    return { protocol: HOT_PROTOCOL_VERSION, outcome: "conflict", reason, canonicalPath: path, binding, remote };
  }

  /**
   * `POST /v1/hot/release` — the client's orderly exit.
   *
   * The client states the revision it needs covered, and the answer says whether the path is free. A
   * release that cannot checkpoint is *not* a release: the path stays fenced and the plugin is told it
   * has to come back, rather than being told a save happened that did not.
   */
  async release(input: HotReleaseRequest): Promise<HotReleaseResult> {
    const room = this.room(input.documentId);
    if (!room) return { protocol: HOT_PROTOCOL_VERSION, outcome: "not-owner" };
    // The room removes this client before counting, so the answer is about the *other* clients: a
    // device asking to be released must not be counted as still holding the path.
    const released = await room.releaseClient({
      clientId: input.clientId,
      epoch: input.epoch,
      checkpoint: input.checkpoint,
      lastAcceptedRevision: input.lastAcceptedRevision,
    }).catch(() => null);
    if (!released || released.outcome === "not-owner") return { protocol: HOT_PROTOCOL_VERSION, outcome: "not-owner" };
    if (released.outcome === "released" && released.remainingClients === 0) {
      await this.releaseOwnership({ documentId: input.documentId, epoch: input.epoch });
    }
    return {
      protocol: HOT_PROTOCOL_VERSION,
      outcome: released.remainingClients > 0 ? "checkpoint-pending" : released.outcome,
      latestAcceptedRevision: released.latestAcceptedRevision,
      latestCheckpointedRevision: released.latestCheckpointedRevision,
      remainingClients: released.remainingClients,
    };
  }

  /* --------------------------------------------------------------------------------------------
   * Namespace operations
   * ------------------------------------------------------------------------------------------ */

  private operation(operationId: string): NamespaceOperationRecord | null {
    const row = [...this.sql().exec<OperationRow>("SELECT * FROM namespace_ops WHERE operation_id = ?", operationId)][0];
    if (!row) return null;
    return {
      operationId: String(row.operation_id),
      type: String(row.type) as NamespaceIntent["type"],
      phase: String(row.phase) as NamespacePhase,
      canonicalPath: String(row.canonical_path),
      fromPath: row.from_path === null ? null : String(row.from_path),
      intent: JSON.parse(String(row.intent)) as NamespaceIntent,
      result: row.result ? JSON.parse(String(row.result)) as NamespaceResult : null,
      updatedAt: Number(row.updated_at),
    };
  }

  private recordOperation(intent: NamespaceIntent, phase: NamespacePhase, result: NamespaceResult | null): void {
    const canonicalPath = intent.type === "rename" ? intent.toPath : intent.canonicalPath;
    const fromPath = intent.type === "rename" ? intent.fromPath : null;
    this.sql().exec(
      `INSERT INTO namespace_ops (operation_id, type, phase, canonical_path, from_path, document_id, epoch, intent, result, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET phase = excluded.phase, result = excluded.result, canonical_path = excluded.canonical_path, from_path = excluded.from_path, document_id = excluded.document_id, epoch = excluded.epoch, updated_at = excluded.updated_at`,
      intent.operationId,
      intent.type,
      phase,
      canonicalPath,
      fromPath,
      intent.type === "create" ? null : intent.documentId,
      intent.type === "create" ? null : intent.expectedEpoch,
      JSON.stringify(intent),
      result ? JSON.stringify(result) : null,
      this.now(),
    );
    // An intermediate phase means work is outstanding and its client may never come back. Arming a
    // resume here — where the phase is written, rather than at each call site — is what makes "durable
    // phase machine" a property of the object instead of a promise about its callers.
    if (phase !== "acked" && phase !== "failed") void this.armResume();
  }

  /**
   * The resume that makes a namespace operation finish without its client.
   *
   * Every phase is written before the act it describes, so a crash between two phases leaves a record of
   * unfinished work — and until now the only thing that could finish it was the original caller asking
   * again with the same operation id. A device that is gone cannot ask, and a path left in `quiescing`
   * is a path nobody can write to. The alarm retries the stored intent a bounded number of times and then
   * fails it *explicitly*, releasing the path either way.
   */
  async alarm(): Promise<void> {
    const pending = [...this.sql().exec<{ operation_id: string; intent: string; phase: string; resume_attempts: number }>(
      "SELECT operation_id, intent, phase, resume_attempts FROM namespace_ops WHERE phase NOT IN ('acked', 'failed') ORDER BY updated_at",
    )];
    for (const row of pending) {
      let intent: NamespaceIntent | null = null;
      try {
        const parsed: unknown = JSON.parse(String(row.intent));
        intent = isNamespaceIntent(parsed) ? parsed : null;
      } catch { intent = null; }
      if (!intent) {
        this.sql().exec("UPDATE namespace_ops SET phase = 'failed', updated_at = ? WHERE operation_id = ?", this.now(), String(row.operation_id));
        continue;
      }
      if (Number(row.resume_attempts) >= MAX_NAMESPACE_RESUME_ATTEMPTS) {
        // Give up loudly: the operation is marked failed, the caller's retry reports that, and the path
        // stops being quiescing so it can be used again. Leaving it pending forever would be the one
        // outcome worse than a failure.
        this.recordFailure(intent, "resume-exhausted");
        this.releaseQuiescingBinding(intent);
        continue;
      }
      this.sql().exec("UPDATE namespace_ops SET resume_attempts = resume_attempts + 1, updated_at = ? WHERE operation_id = ?", this.now(), String(row.operation_id));
      try {
        await this.namespace(intent);
      } catch (error) {
        this.log(`namespace resume failed id=${intent.operationId} error=${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    if (this.hasPendingOperations()) await this.ctx.storage.setAlarm(this.now() + NAMESPACE_RESUME_MS);
  }

  private hasPendingOperations(): boolean {
    const rows = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM namespace_ops WHERE phase NOT IN ('acked', 'failed')")];
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /** Arms one resume, without pushing an already-armed alarm further out. */
  private async armResume(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(this.now() + NAMESPACE_RESUME_MS);
  }

  /** Records a definite failure for an operation nobody is left to finish. */
  private recordFailure(intent: NamespaceIntent, reason: NamespaceReason): void {
    const binding = this.bindingRow(intent.type === "rename" ? intent.toPath : intent.canonicalPath);
    this.recordOperation(intent, "failed", this.outcome({
      intent,
      path: intent.type === "rename" ? intent.toPath : intent.canonicalPath,
      fromPath: intent.type === "rename" ? intent.fromPath : null,
      outcome: "rejected",
      reason,
      phase: "failed",
      binding: binding ? this.toBinding(binding) : null,
    }));
  }

  /**
   * Puts a path back into service after its operation gave up.
   *
   * Only a `quiescing` binding is touched, and only when it still names the document the failed operation
   * was about: if anything else has happened to the path since, it is no longer this operation's to
   * change.
   */
  private releaseQuiescingBinding(intent: NamespaceIntent): void {
    if (intent.type === "create") return;
    // A rename quiesces its *source* path; a delete quiesces the path it is deleting.
    const path = intent.type === "rename" ? intent.fromPath : intent.canonicalPath;
    const row = this.bindingRow(path);
    if (!row || String(row.state) !== "quiescing") return;
    if (String(row.document_id) !== intent.documentId || Number(row.epoch) !== intent.expectedEpoch) return;
    this.setBindingState(path, "active");
  }

  private log(message: string): void {
    // Diagnostics only: a coordinator's failure to resume is not the caller's error to handle.
    console.log(`namespace ${message}`);
  }

  private outcome(input: {
    intent: NamespaceIntent;
    path: string;
    fromPath: string | null;
    outcome: NamespaceOutcome;
    reason?: NamespaceReason;
    phase: NamespacePhase;
    binding: PathBinding | null;
    fromBinding?: PathBinding | null;
    identity?: { documentId: string; epoch: DocumentEpoch } | null;
    checkpoint?: NamespaceResult["checkpoint"];
  }): NamespaceResult {
    return {
      protocol: NAMESPACE_PROTOCOL_VERSION,
      operationId: input.intent.operationId,
      type: input.intent.type,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      phase: input.phase,
      canonicalPath: input.path,
      ...(input.fromPath ? { fromPath: input.fromPath } : {}),
      binding: input.binding,
      ...(input.fromBinding !== undefined ? { fromBinding: input.fromBinding } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    };
  }

  /** The commit id a namespace operation's R2 act is journalled under. Stable across retries. */
  private async commitIdFor(operationId: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationId));
    let binary = "";
    for (const byte of new Uint8Array(digest).slice(0, 16)) binary += String.fromCharCode(byte);
    return `ns-${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
  }

  /**
   * The three lifecycle operations, dispatched by intent type.
   *
   * A settled operation is answered from its own record: the whole point of carrying an `operationId`
   * is that a client whose response was lost can ask again and receive the original result rather than
   * performing the mutation a second time.
   *
   * The identity of the *intent* is checked first, though. An operation id is a caller-chosen key, and
   * two different intents that happen to share one — a recycled counter, a copy-pasted client — must
   * never be answered with each other's result. That failure would be invisible and catastrophic: a
   * rename reported as applied against a path the caller never named.
   */
  async namespace(intent: NamespaceIntent): Promise<NamespaceResult> {
    const stored = this.operation(intent.operationId);
    if (stored && !sameIntent(stored.intent, intent)) {
      return this.outcome({
        intent,
        path: intent.type === "rename" ? intent.toPath : intent.canonicalPath,
        fromPath: intent.type === "rename" ? intent.fromPath : null,
        outcome: "conflict",
        reason: "stale-intent",
        phase: stored.phase,
        binding: null,
      });
    }
    if (stored?.result && stored.result.outcome === "applied") return stored.result;
    if (intent.type === "create") return this.create(intent);
    if (intent.type === "delete") return this.delete(intent);
    return this.rename(intent);
  }

  private async create(intent: Extract<NamespaceIntent, { type: "create" }>): Promise<NamespaceResult> {
    const path = intent.canonicalPath;
    const existing = this.bindingRow(path);
    if (existing && String(existing.state) === "active") {
      const result = this.outcome({ intent, path, fromPath: null, outcome: "conflict", reason: "path-taken", phase: "failed", binding: this.toBinding(existing) });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    const acquired = await this.acquire({
      protocol: HOT_PROTOCOL_VERSION,
      operationId: intent.operationId,
      canonicalPath: path,
      clientId: intent.clientId,
      expected: { state: "absent" },
      local: intent.local,
      wantSession: true,
    });
    if (acquired.outcome === "created" || acquired.outcome === "joined") {
      const result = this.outcome({ intent, path, fromPath: null, outcome: "applied", phase: "acked", binding: acquired.binding, identity: acquired.identity ?? null });
      this.recordOperation(intent, "acked", result);
      return result;
    }
    const reason: NamespaceReason = acquired.reason === "invalid" || acquired.reason === "unavailable" || acquired.reason === "path-taken"
      || acquired.reason === "binding-changed" || acquired.reason === "stale-epoch" || acquired.reason === "quiescing"
      || acquired.reason === "remote-deleted"
      ? acquired.reason
      : "remote-changed";
    const result = this.outcome({ intent, path, fromPath: null, outcome: acquired.outcome === "conflict" ? "conflict" : "rejected", reason, phase: "failed", binding: acquired.binding });
    this.recordOperation(intent, "failed", result);
    return result;
  }

  /**
   * Deletion as a durable state machine.
   *
   * Every phase is persisted *before* the act it describes, so a crash leaves a record of what was
   * already done and a retry with the same operation id resumes rather than repeating a tombstone or a
   * checkpoint. That is the difference between an idempotent operation and one that merely usually
   * works.
   */
  private async delete(intent: Extract<NamespaceIntent, { type: "delete" }>): Promise<NamespaceResult> {
    const path = intent.canonicalPath;
    const row = this.bindingRow(path);
    const binding = row ? this.toBinding(row) : null;
    if (!binding || binding.documentId === null) {
      const result = this.outcome({ intent, path, fromPath: null, outcome: "conflict", reason: "unknown-document", phase: "failed", binding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    if (binding.documentId !== intent.documentId) {
      const result = this.outcome({ intent, path, fromPath: null, outcome: "conflict", reason: "binding-changed", phase: "failed", binding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    if (binding.state === "deleted") {
      // A different operation id asking to delete something already deleted is not a retry, and
      // answering "applied" would claim a transition this call did not perform.
      const result = this.outcome({ intent, path, fromPath: null, outcome: "conflict", reason: "remote-deleted", phase: "failed", binding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    if (binding.epoch !== intent.expectedEpoch) {
      const result = this.outcome({ intent, path, fromPath: null, outcome: "conflict", reason: "stale-epoch", phase: "failed", binding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    const vault = this.vault();
    const room = this.room(intent.documentId);
    if (!vault || !room) return this.outcome({ intent, path, fromPath: null, outcome: "rejected", reason: "unavailable", phase: "requested", binding });

    const phase = this.operation(intent.operationId)?.phase ?? "requested";
    let checkpoint: NamespaceResult["checkpoint"];
    let expectedFromRoom: string | null = null;
    if (binding.state !== "quiescing" || phase === "requested") {
      this.recordOperation(intent, "quiescing", null);
      this.setBindingState(path, "quiescing");
      const quiesced = await room.quiesce({ expectedEpoch: intent.expectedEpoch, mode: "delete", upToRevision: intent.expectedDocumentRevision });
      if (!quiesced.ok) {
        const current = this.bindingRow(path);
        const result = this.outcome({
          intent,
          path,
          fromPath: null,
          outcome: "conflict",
          reason: quiesced.reason === "stale-epoch" ? "stale-epoch" : "checkpoint-failed",
          phase: "failed",
          binding: current ? this.toBinding(current) : binding,
        });
        this.recordOperation(intent, "failed", result);
        if (!quiesced.conflicted) this.setBindingState(path, "active");
        return result;
      }
      checkpoint = quiesced.receipt ?? undefined;
      expectedFromRoom = quiesced.expectedRemoteETag;
      this.recordOperation(intent, "checkpointed", null);
    }

    // The room's own expectation is the authoritative precondition for the room's content; the intent's
    // value is a fallback for a retry that resumes after the quiesce phase.
    const description = await room.identity().catch(() => null);
    const expected = expectedFromRoom ?? description?.expectedRemoteETag ?? intent.expectedRemoteETag ?? null;
    const deletion: HotDeleteResult = await vault.deleteHotDocument({
      canonicalPath: path,
      documentId: intent.documentId,
      epoch: intent.expectedEpoch,
      commitId: await this.commitIdFor(intent.operationId),
      expectedRemoteETag: expected,
    });
    if (deletion.status !== "deleted") {
      const current = this.bindingRow(path);
      const reason: NamespaceReason = deletion.status === "conflict"
        ? (deletion.reason === "remote-deleted" ? "remote-deleted" : "remote-changed")
        : "unavailable";
      const result = this.outcome({ intent, path, fromPath: null, outcome: deletion.status === "conflict" ? "conflict" : "rejected", reason, phase: "failed", binding: current ? this.toBinding(current) : binding });
      this.recordOperation(intent, "failed", result);
      if (deletion.status === "conflict") this.setBindingState(path, "conflicted");
      else {
        await room.resume({ expectedEpoch: intent.expectedEpoch });
        this.setBindingState(path, "active");
      }
      return result;
    }
    this.recordOperation(intent, "r2-applied", null);

    const retired: PathBinding = { ...binding, state: "deleted", updatedAt: this.now() };
    this.putBinding(retired);
    await room.retire({ expectedEpoch: intent.expectedEpoch });
    this.sql().exec("DELETE FROM hot_ownership WHERE canonical_path = ?", path);

    const result = this.outcome({ intent, path, fromPath: null, outcome: "applied", phase: "acked", binding: retired, identity: { documentId: intent.documentId, epoch: intent.expectedEpoch }, checkpoint });
    this.recordOperation(intent, "acked", result);
    return result;
  }

  /**
   * Rename: release the old path, claim the new one, keep the document, bump the epoch.
   *
   * The epoch bump is not bookkeeping — it is the fence. Messages produced before the rename carry the
   * old epoch and are refused afterwards, so a packet that was in flight cannot be applied to the
   * document's new incarnation.
   */
  private async rename(intent: Extract<NamespaceIntent, { type: "rename" }>): Promise<NamespaceResult> {
    const fromPath = intent.fromPath;
    const toPath = intent.toPath;
    const fromRow = this.bindingRow(fromPath);
    const fromBinding = fromRow ? this.toBinding(fromRow) : null;
    if (!fromBinding || fromBinding.documentId !== intent.documentId || fromBinding.epoch !== intent.expectedEpoch) {
      const reason: NamespaceReason = !fromBinding || fromBinding.state === "deleted" ? "source-missing" : fromBinding.epoch !== intent.expectedEpoch ? "stale-epoch" : "binding-changed";
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason, phase: "failed", binding: fromBinding, fromBinding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    if (intent.expectedFromBinding && (intent.expectedFromBinding.documentId !== fromBinding.documentId || intent.expectedFromBinding.epoch !== fromBinding.epoch)) {
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason: "stale-intent", phase: "failed", binding: fromBinding, fromBinding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    const targetRow = this.bindingRow(toPath);
    const targetBinding = targetRow ? this.toBinding(targetRow) : null;
    if (targetBinding && targetBinding.state !== "deleted") {
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason: "target-exists", phase: "failed", binding: targetBinding, fromBinding });
      this.recordOperation(intent, "failed", result);
      return result;
    }
    const vault = this.vault();
    const room = this.room(intent.documentId);
    if (!vault || !room) return this.outcome({ intent, path: toPath, fromPath, outcome: "rejected", reason: "unavailable", phase: "requested", binding: targetBinding, fromBinding });

    const observation = await this.observe(toPath, false);
    if (!observation) return this.outcome({ intent, path: toPath, fromPath, outcome: "rejected", reason: "unavailable", phase: "requested", binding: targetBinding, fromBinding });
    if (observation.observation.exists) {
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason: "target-exists", phase: "failed", binding: observation.observation ? targetBinding : null, fromBinding });
      this.recordOperation(intent, "failed", result);
      return result;
    }

    this.recordOperation(intent, "quiescing", null);
    this.setBindingState(fromPath, "quiescing");
    const quiesced = await room.quiesce({ expectedEpoch: intent.expectedEpoch, mode: "rename", upToRevision: null });
    if (!quiesced.ok) {
      const current = this.bindingRow(fromPath);
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason: quiesced.reason === "stale-epoch" ? "stale-epoch" : "checkpoint-failed", phase: "failed", binding: current ? this.toBinding(current) : fromBinding, fromBinding: current ? this.toBinding(current) : fromBinding });
      this.recordOperation(intent, "failed", result);
      if (!quiesced.conflicted) this.setBindingState(fromPath, "active");
      return result;
    }
    if (!quiesced.expectedRemoteETag) {
      // The source is not in R2 under the revision the room believes in. Moving content that is not
      // there would either lose the file or overwrite whatever is.
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: "conflict", reason: "remote-changed", phase: "failed", binding: fromBinding, fromBinding });
      this.recordOperation(intent, "failed", result);
      await room.resume({ expectedEpoch: intent.expectedEpoch });
      this.setBindingState(fromPath, "active");
      return result;
    }
    this.recordOperation(intent, "checkpointed", null);

    const moved: HotMoveResult = await vault.moveHotDocument({
      fromPath,
      toPath,
      documentId: intent.documentId,
      epoch: intent.expectedEpoch,
      documentRevision: quiesced.documentRevision,
      commitId: await this.commitIdFor(intent.operationId),
      contentHash: quiesced.contentHash,
      markdown: quiesced.markdown,
      expectedFromETag: quiesced.expectedRemoteETag,
    });
    if (moved.status !== "moved") {
      const reason: NamespaceReason = moved.status === "conflict"
        ? moved.reason === "target-exists" ? "target-exists" : moved.reason === "remote-deleted" ? "remote-deleted" : "remote-changed"
        : "unavailable";
      const result = this.outcome({ intent, path: toPath, fromPath, outcome: moved.status === "conflict" ? "conflict" : "rejected", reason, phase: "failed", binding: fromBinding, fromBinding });
      this.recordOperation(intent, "failed", result);
      if (moved.status === "conflict" && moved.reason === "remote-changed") this.setBindingState(fromPath, "conflicted");
      else {
        await room.resume({ expectedEpoch: intent.expectedEpoch });
        this.setBindingState(fromPath, "active");
      }
      return result;
    }
    this.recordOperation(intent, "r2-applied", null);

    const newEpoch = intent.expectedEpoch + 1;
    const retired: PathBinding = { ...fromBinding, state: "deleted", updatedAt: this.now() };
    const claimed: PathBinding = { canonicalPath: toPath, documentId: intent.documentId, epoch: newEpoch, state: "active", updatedAt: this.now() };
    this.putBinding(retired);
    this.putBinding(claimed);
    const description = await room.renameEpoch({ expectedEpoch: intent.expectedEpoch, newEpoch, canonicalPath: toPath, etag: moved.etag, contentHash: quiesced.contentHash });
    this.sql().exec("DELETE FROM hot_ownership WHERE canonical_path = ?", fromPath);
    if (description) this.claimOwnership(toPath, intent.documentId, newEpoch);

    const result = this.outcome({
      intent,
      path: toPath,
      fromPath,
      outcome: "applied",
      phase: "acked",
      binding: claimed,
      fromBinding: retired,
      identity: { documentId: intent.documentId, epoch: newEpoch },
      checkpoint: quiesced.receipt ?? undefined,
    });
    this.recordOperation(intent, "acked", result);
    return result;
  }

  /* --------------------------------------------------------------------------------------------
   * Conflict resolution
   * ------------------------------------------------------------------------------------------ */

  /**
   * The two decisions a frozen hot conflict needs, and nothing else.
   *
   * `keep-local` re-points the room at the state the user chose to keep: the revision R2 holds now — or
   * the retired one, when the conflict was an external deletion — becomes the precondition for the next
   * checkpoint, and ownership stays where it is. `accept-remote` retires this path's hot claim and lets
   * the cold path apply whatever R2 holds, which is the same code path that would have run if the file
   * had never been opened hot.
   *
   * Neither choice writes content. The bytes are already where they are; this only decides which
   * authority may act next.
   */
  async resolveHotConflict(input: { canonicalPath: string; documentId: string; epoch: DocumentEpoch; decision: "keep-local" | "accept-remote" }): Promise<{ outcome: "resolved" | "abandoned" | "not-found" }> {
    const path = canonicalVaultPath(input.canonicalPath);
    if (!path) return { outcome: "not-found" };
    const room = this.room(input.documentId);
    if (!room) return { outcome: "not-found" };

    // The path has to actually belong to the document the caller names. Without this, a stale or
    // mistaken request could re-point one document's room at another path's revision — or, worse for
    // `accept-remote`, drop a *different* document's ownership of this path.
    const binding = this.bindingRow(path) ? this.toBinding(this.bindingRow(path)!) : null;
    if (binding?.documentId !== input.documentId || binding.epoch !== input.epoch) return { outcome: "not-found" };
    if (binding.state === "deleted") return { outcome: "not-found" };

    if (input.decision === "accept-remote") {
      // The room keeps whatever state it had, but it stops being an owner: the fence comes down and the
      // cold planner reconciles the local file against R2 with its ordinary rules.
      this.sql().exec("DELETE FROM hot_ownership WHERE canonical_path = ?", path);
      this.sql().exec("DELETE FROM cold_leases WHERE canonical_path = ?", path);
      return { outcome: "abandoned" };
    }

    const observation = await this.observe(path, false);
    const description = await room.identity().catch(() => null);
    if (!observation || !description) return { outcome: "not-found" };
    const remote = observation.observation;
    const resolved = await room.resolveConflict({
      expectedEpoch: input.epoch,
      remoteETag: remote.etag,
      contentHash: description.currentContentHash,
      canonicalPath: path,
      // Replacing a retired revision is the deliberate act that turns "keep local" over an external
      // deletion into a new effective incarnation instead of the resurrection the Vault refuses.
      replaceTombstonedRevision: remote.deleted,
    });
    if (!resolved) return { outcome: "not-found" };
    this.claimOwnership(path, input.documentId, input.epoch);
    return { outcome: "resolved" };
  }

  /** Paths this knowledge base currently treats as hot-owned, for diagnostics. */
  async hotOwnership(): Promise<Array<{ canonicalPath: string; documentId: string; epoch: DocumentEpoch }>> {
    return [...this.sql().exec<{ canonical_path: string; document_id: string; epoch: number }>("SELECT canonical_path, document_id, epoch FROM hot_ownership")]
      .map(row => ({ canonicalPath: String(row.canonical_path), documentId: String(row.document_id), epoch: Number(row.epoch) }));
  }

  /* --------------------------------------------------------------------------------------------
   * Cold-mutation authority
   * ------------------------------------------------------------------------------------------ */

  /**
   * The lease a cold writer must hold before it touches a shared path.
   *
   * The point is not ceremony: it closes the "check, then write 300 ms later" window, because the same
   * object that grants the lease is the one that records hot ownership. A path that becomes hot in
   * between is caught at commit time, and the room's conditional checkpoint catches whatever still
   * slips through.
   */
  async coldAcquire(input: ColdAuthorityRequest): Promise<ColdAuthorityResult> {
    const path = canonicalVaultPath(input.canonicalPath);
    if (!path) return { protocol: HOT_PROTOCOL_VERSION, outcome: "denied", reason: "invalid", binding: null, remote: null };
    const { owned, binding } = await this.ownership(path);
    if (binding && binding.state === "quiescing") return { protocol: HOT_PROTOCOL_VERSION, outcome: "denied", reason: "quiescing", binding, remote: null };
    if (owned) return { protocol: HOT_PROTOCOL_VERSION, outcome: "denied", reason: "hot-owned", binding, remote: null };
    const observation = await this.observe(path, false);
    if (!observation) return { protocol: HOT_PROTOCOL_VERSION, outcome: "denied", reason: "unavailable", binding, remote: null };
    const remote = observation.observation;
    if (input.expectedRemoteETag !== null && remote.etag !== input.expectedRemoteETag) {
      return { protocol: HOT_PROTOCOL_VERSION, outcome: "denied", reason: "remote-changed", binding, remote };
    }
    const token = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = this.now() + COLD_LEASE_TTL_MS;
    this.sql().exec(
      "INSERT INTO cold_leases (token, canonical_path, client_id, operation_id, operation, expected_remote_etag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      token,
      path,
      input.clientId,
      input.operationId,
      input.operation,
      input.expectedRemoteETag,
      expiresAt,
    );
    this.sweepLeases();
    return { protocol: HOT_PROTOCOL_VERSION, outcome: "granted", token, expiresAt, binding, remote };
  }

  /**
   * What the cold writer reports after its conditional write.
   *
   * `raced` is the interesting answer: the write landed, but a hot session took the path while it was
   * in flight, so the room must re-verify before it checkpoints. Nothing is rolled back — the bytes are
   * already in R2 — the collision is reported so both sides can see it.
   */
  async coldCommit(input: ColdAuthorityCommit): Promise<ColdCommitOutcome> {
    const path = canonicalVaultPath(input.canonicalPath);
    if (!path) return { outcome: "unknown-lease", canonicalPath: input.canonicalPath, binding: null, remote: null, hotOwned: false };
    const rows = [...this.sql().exec<LeaseRow>("SELECT * FROM cold_leases WHERE token = ?", input.token)];
    if (rows.length === 0) return { outcome: "unknown-lease", canonicalPath: path, binding: null, remote: null, hotOwned: false };
    const lease = rows[0];
    this.sql().exec("DELETE FROM cold_leases WHERE token = ?", input.token);
    if (String(lease.canonical_path) !== path || String(lease.client_id) !== input.clientId || String(lease.operation_id) !== input.operationId) {
      return { outcome: "unknown-lease", canonicalPath: path, binding: null, remote: null, hotOwned: false };
    }
    const expired = Number(lease.expires_at) < this.now();
    const { owned, binding } = await this.ownership(path);
    const observation = await this.observe(path, false);
    if (expired) return { outcome: "expired", canonicalPath: path, binding, remote: observation?.observation ?? null, hotOwned: owned };
    return { outcome: owned ? "raced" : "recorded", canonicalPath: path, binding, remote: observation?.observation ?? null, hotOwned: owned };
  }

  async coldRelease(input: { token: string }): Promise<boolean> {
    const token = typeof input?.token === "string" ? input.token : "";
    const rows = [...this.sql().exec<{ token: string }>("SELECT token FROM cold_leases WHERE token = ?", token)];
    if (rows.length === 0) return false;
    this.sql().exec("DELETE FROM cold_leases WHERE token = ?", token);
    return true;
  }

  private sweepLeases(): void {
    this.sql().exec("DELETE FROM cold_leases WHERE expires_at < ?", this.now());
  }

  /** The client-facing question the cold executor asks before it touches a path. */
  async pathStatus(input: { canonicalPath: string }): Promise<{ binding: PathBinding | null; remote: HotRemoteObservation | null; hotOwned: boolean }> {
    const path = canonicalVaultPath(input?.canonicalPath);
    if (!path) return { binding: null, remote: null, hotOwned: false };
    const { owned, binding } = await this.ownership(path);
    const observation = await this.observe(path, false);
    return { binding, remote: observation?.observation ?? null, hotOwned: owned };
  }

  /** Aggregate diagnostics: counts only, never a path. */
  async health(): Promise<Record<string, unknown>> {
    const bindings = [...this.sql().exec<{ state: string; count: number }>("SELECT state, COUNT(*) AS count FROM path_bindings GROUP BY state")];
    const ops = [...this.sql().exec<{ phase: string; count: number }>("SELECT phase, COUNT(*) AS count FROM namespace_ops GROUP BY phase")];
    const leases = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM cold_leases")];
    const ownership = [...this.sql().exec<{ count: number }>("SELECT COUNT(*) AS count FROM hot_ownership")];
    return {
      bindings: Object.fromEntries(bindings.map(row => [String(row.state), Number(row.count)])),
      operations: Object.fromEntries(ops.map(row => [String(row.phase), Number(row.count)])),
      leases: Number(leases[0]?.count ?? 0),
      ownership: Number(ownership[0]?.count ?? 0),
    };
  }
}

/** A 22-character base64url document id: 16 random bytes, and never a path. */
function newDocumentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * The path an intent's result is reported against: a rename reports the path it claims.
 */
function targetPath(intent: NamespaceIntent): string {
  return intent.type === "rename" ? intent.toPath : intent.canonicalPath;
}

/**
 * Whether two intents are the same operation.
 *
 * Identity is the fields that decide what the operation *does*: a create for another path, a delete of
 * another epoch, or a rename with another target is a different operation wearing the same id.
 */
function sameIntent(left: NamespaceIntent, right: NamespaceIntent): boolean {
  if (left.type !== right.type || targetPath(left) !== targetPath(right)) return false;
  if (left.type === "create" && right.type === "create") return true;
  if (left.type === "delete" && right.type === "delete") return left.documentId === right.documentId && left.expectedEpoch === right.expectedEpoch;
  if (left.type === "rename" && right.type === "rename") {
    return left.fromPath === right.fromPath && left.toPath === right.toPath && left.documentId === right.documentId && left.expectedEpoch === right.expectedEpoch;
  }
  return false;
}

/** The hash of an empty document; a client whose file is empty presents exactly this. */
function emptyContentHash(): string {
  return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}


