/**
 * Serializable contract between the MCP Worker and the Vault Worker.
 *
 * This deliberately excludes Cloudflare storage handles and Vault runtime
 * classes. The MCP side may depend only on these DTOs and operations.
 */
import type { HotRemoteObservation } from "@mineral/sync-core/hot-protocol";

export type VaultRpcDocumentMetadata = {
  key: string;
  size: number;
  modified: string;
  uploaded: string;
  contentType: string | null;
  httpMetadata: { contentType?: string } | null;
  customMetadata: Record<string, string> | null;
};

export type VaultRpcDocument = VaultRpcDocumentMetadata & {
  bytes: Uint8Array;
};

export type PutDocumentInput = {
  key: string;
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
};

/**
 * The journal fact a committed write produced.
 *
 * It is the whole repair payload: a caller that saw `mutationPending` can hand these four fields back
 * to `recordCommittedMutation`, with the same id, and never re-execute the write.
 */
export type MutationReference = {
  mutationId: string;
  mutationSeq: number;
  /** `true` when R2 committed but the fact did not; the caller should hand it back. */
  mutationPending: boolean;
};

/**
 * The revision a write committed, plus the journal fact that records it.
 */
export type PutDocumentResult = MutationReference & {
  etag: string;
  size: number;
};

export type DeleteDocumentsResult = {
  deleted: string[];
  /**
   * One reference per deleted key, in the same order as `deleted`.
   *
   * It is per key rather than one flag for the batch because a repair must reuse the id of the fact
   * that actually failed, and a batch can fail for one key and not another.
   */
  mutations: MutationReference[];
  /** The revision each object held when it was removed, in the same order as `deleted`. */
  etags: Array<string | null>;
  mutationPending: boolean;
};

/**
 * A fact about an R2 write the Vault already committed, submitted for recording only.
 *
 * A caller that observed `mutationPending: true` can hand this back — same `mutationId` — to make the
 * change reach the gateway and the index. It never writes the file again, and it is idempotent, so it
 * may be retried as often as the caller likes.
 */
export type CommittedMutationInput = {
  id: string;
  source: "mcp" | "web" | "system";
  op: "put" | "delete" | "rename";
  path: string;
  etag?: string;
  size?: number;
  from?: string;
  committedAt: number;
};

export type RecordCommittedMutationResult = {
  recorded: boolean;
  seq?: number;
  attempts: number;
};

export type ListDocumentsInput = {
  prefix?: string;
  cursor?: string;
  limit?: number;
  include?: string[];
};

export type ListDocumentsResult = {
  items: VaultRpcDocumentMetadata[];
  objects: VaultRpcDocumentMetadata[];
  cursor: string | null;
  truncated: boolean;
};

/* ------------------------------------------------------------------------------------------------
 * Hot checkpoint surface (Phase Hot-B)
 *
 * The Gateway's LiveDocumentRoom owns the CRDT and the checkpoint schedule; the Vault owns R2 and the
 * journal. These four operations are the whole seam between them. Every one of them is a
 * *conditional* R2 act: the caller states the revision it expects to be acting on, and a mismatch is
 * answered as a conflict rather than resolved by whoever wrote last.
 * ---------------------------------------------------------------------------------------------- */

/** An observation plus, on request, the material the room is seeded with. */
export type HotPathObservation = {
  observation: HotRemoteObservation;
  content?: string;
};

export type HotCheckpointInput = {
  /** Vault-relative path; the Vault composes the configured remote prefix itself. */
  canonicalPath: string;
  documentId: string;
  epoch: number;
  documentRevision: number;
  /** Both the journal idempotency key and the commit identity the object records. */
  commitId: string;
  contentHash: string;
  markdown: string;
  /** `null` means "this path must not exist yet", which is how a create stays a create. */
  expectedRemoteETag: string | null;
  /**
   * `true` only for a room that was created *over a tombstoned revision* — the recreate case.
   *
   * The default is the safe one: a live tombstone on the revision a room is building on means the
   * document was deleted while (or after) the room held it, and writing anyway would resurrect a file
   * someone deliberately removed. A brand-new incarnation on a deleted path is the one case where
   * replacing the retired revision is the intent, and it has to say so explicitly.
   */
  replaceTombstonedRevision: boolean;
};

export type HotCheckpointResult =
  | {
    status: "committed";
    canonicalPath: string;
    etag: string;
    size: number;
    contentHash: string;
    commitId: string;
    documentRevision: number;
    mutationSeq: number;
    mutationPending: boolean;
    /** `true` when this call found its own earlier commit already in R2 after a lost response. */
    recovered: boolean;
  }
  | { status: "conflict"; reason: "remote-changed" | "remote-deleted" | "already-exists"; observation: HotRemoteObservation }
  | { status: "failed"; reason: "invalid" | "hash-mismatch" | "unavailable"; detail?: string };

export type HotDeleteInput = {
  canonicalPath: string;
  documentId: string;
  epoch: number;
  commitId: string;
  /** The exact revision this deletion intends to retire; `null` means "the path is already absent". */
  expectedRemoteETag: string | null;
};

export type HotDeleteResult =
  | {
    status: "deleted";
    canonicalPath: string;
    retiredETag: string | null;
    mutationSeq: number;
    mutationPending: boolean;
    /** `true` when the object was already gone or already tombstoned, so nothing was retired twice. */
    alreadyDeleted: boolean;
  }
  | { status: "conflict"; reason: "remote-changed" | "remote-deleted"; observation: HotRemoteObservation }
  | { status: "failed"; reason: "invalid" | "unavailable"; detail?: string };

export type HotMoveInput = {
  fromPath: string;
  toPath: string;
  documentId: string;
  epoch: number;
  documentRevision: number;
  commitId: string;
  contentHash: string;
  markdown: string;
  /** The revision the source must still hold for the move to be safe. */
  expectedFromETag: string;
};

export type HotMoveResult =
  | {
    status: "moved";
    fromPath: string;
    toPath: string;
    etag: string;
    size: number;
    contentHash: string;
    retiredETag: string;
    mutationSeq: number;
    mutationPending: boolean;
  }
  | { status: "conflict"; reason: "remote-changed" | "remote-deleted" | "target-exists"; observation: HotRemoteObservation }
  | { status: "failed"; reason: "invalid" | "hash-mismatch" | "unavailable"; detail?: string };

/** The Vault, as the Gateway's LiveDocumentRoom needs it. */
export type VaultHotRpc = {
  observeHotPath(input: { canonicalPath: string; withContent?: boolean }): Promise<HotPathObservation>;
  checkpointHotDocument(input: HotCheckpointInput): Promise<HotCheckpointResult>;
  deleteHotDocument(input: HotDeleteInput): Promise<HotDeleteResult>;
  moveHotDocument(input: HotMoveInput): Promise<HotMoveResult>;
};

export type VaultRpc = {
  getDocument(key: string): Promise<VaultRpcDocument | null>;
  headDocument(key: string): Promise<VaultRpcDocumentMetadata | null>;
  listDocuments(input?: ListDocumentsInput): Promise<ListDocumentsResult>;
  putDocument(input: PutDocumentInput): Promise<PutDocumentResult>;
  deleteDocuments(keys: string | string[]): Promise<DeleteDocumentsResult>;
  backupTextDocument(key: string, text: string, contentType?: string): Promise<string>;
  moveDocument(from: string, to: string): Promise<void>;
  queryIndex(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshIndex(): Promise<Record<string, unknown>>;
  /**
   * Asks the deployed Vault how wide the embedding model's vectors really are.
   *
   * It is an operator diagnostic, and it is optional for the same reason `recordCommittedMutation` is:
   * a Vault with no AI binding cannot answer it, and that is a fact about the deployment rather than a
   * client error. The width is immutable once a Vectorize index exists, so this runs before creation.
   */
  probeEmbeddingModel?(model?: string): Promise<Record<string, unknown>>;
  /**
   * Semantic search, deliberately separate from the full-text `search` kind.
   *
   * The two answer different questions and have different failure modes: full text can only miss, a
   * vector search can also return a passage that no longer describes the note. Merging them would hide
   * that difference behind one ranking, so they stay separate until the vector half has proven itself.
   */
  searchSemantic?(input: { query: string; limit?: number; prefix?: string }): Promise<Record<string, unknown>>;
  /** Counts and the frozen schema. No paths: the vector index is still the vault. */
  vectorHealth?(): Promise<Record<string, unknown>>;
  /**
   * Optional because it is only meaningful to a caller that saw `mutationPending: true`; a Vault that
   * predates the mutation journal simply does not implement it.
   */
  recordCommittedMutation?(input: CommittedMutationInput): Promise<RecordCommittedMutationResult>;
};
