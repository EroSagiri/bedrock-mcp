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
  putDocument(input: PutDocumentInput): Promise<void>;
  deleteDocuments(keys: string | string[]): Promise<void>;
  backupTextDocument(key: string, text: string, contentType?: string): Promise<string>;
  moveDocument(from: string, to: string): Promise<void>;
  queryIndex(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshIndex(): Promise<Record<string, unknown>>;
};
