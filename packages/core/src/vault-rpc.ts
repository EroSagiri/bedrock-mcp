/**
 * Serializable contract between the MCP Worker and the Vault Worker.
 *
 * This deliberately excludes Cloudflare storage handles and Vault runtime
 * classes. The MCP side may depend only on these DTOs and operations.
 */
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
   * Optional because it is only meaningful to a caller that saw `mutationPending: true`; a Vault that
   * predates the mutation journal simply does not implement it.
   */
  recordCommittedMutation?(input: CommittedMutationInput): Promise<RecordCommittedMutationResult>;
};
