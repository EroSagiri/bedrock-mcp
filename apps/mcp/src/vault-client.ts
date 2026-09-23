import { isTextDocumentKey } from "@mineral/core/keys";
import type {
  CommittedMutationInput,
  DeleteDocumentsResult,
  ListDocumentsInput,
  ListDocumentsResult,
  PutDocumentInput,
  PutDocumentResult,
  RecordCommittedMutationResult,
  VaultRpc,
  VaultRpcDocumentMetadata,
} from "@mineral/core/vault-rpc";

export type VaultDocumentMetadata = Omit<VaultRpcDocumentMetadata, "uploaded"> & { uploaded: Date };
export type VaultDocument = VaultDocumentMetadata & {
  bytes: Uint8Array;
  body: Uint8Array;
  text(): Promise<string>;
};

export type VaultDocumentList = Omit<ListDocumentsResult, "items" | "objects"> & {
  items: VaultDocumentMetadata[];
  objects: VaultDocumentMetadata[];
};

export type VaultDocuments = {
  get(key: string): Promise<VaultDocument | null>;
  metadata(key: string): Promise<VaultDocumentMetadata | null>;
  head(key: string): Promise<VaultDocumentMetadata | null>;
  list(input?: ListDocumentsInput): Promise<VaultDocumentList>;
  put(input: PutDocumentInput): Promise<PutDocumentResult>;
  put(key: string, bytes: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<PutDocumentResult>;
  put(inputOrKey: PutDocumentInput | string, bytes?: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<PutDocumentResult>;
  delete(key: string | string[]): Promise<DeleteDocumentsResult>;
  backupText(key: string, text: string, contentType?: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
};

export type VaultClient = {
  documents: VaultDocuments;
  index: {
    query(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
    refresh(): Promise<Record<string, unknown>>;
  };
  /** `null` when the Vault predates the mutation journal and cannot record a committed write. */
  recordCommittedMutation(input: CommittedMutationInput): Promise<RecordCommittedMutationResult | null>;
};

function metadata(document: VaultRpcDocumentMetadata): VaultDocumentMetadata {
  return { ...document, uploaded: new Date(document.uploaded) };
}

export function createVaultClient(rpc: VaultRpc): VaultClient {
  return {
    documents: {
      async get(key) {
        const document = await rpc.getDocument(key);
        if (!document) return null;
        const result = metadata(document);
        return { ...result, bytes: document.bytes, body: document.bytes, text: async () => new TextDecoder().decode(document.bytes) };
      },
      async metadata(key) {
        const document = await rpc.headDocument(key);
        return document && metadata(document);
      },
      async head(key) { return this.metadata(key); },
      async list(input = {}) {
        const result = await rpc.listDocuments(input);
        const items = result.items.map(metadata);
        return { ...result, items, objects: items };
      },
      async put(inputOrKey: PutDocumentInput | string, bytes?: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
        const input = typeof inputOrKey === "string"
          ? { key: inputOrKey, bytes: bytes!, contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata }
          : inputOrKey;
        return rpc.putDocument(input);
      },
      async delete(keys) { return rpc.deleteDocuments(keys); },
      async backupText(key, text, contentType) { return rpc.backupTextDocument(key, text, contentType); },
      async move(from, to) { await rpc.moveDocument(from, to); },
    },
    index: {
      async query(kind, input) { return rpc.queryIndex(kind, input); },
      async refresh() { return rpc.refreshIndex(); },
    },
    /**
     * The repair half of a write.
     *
     * When a write reports `mutationPending: true`, its bytes are already durable in R2 but the change
     * has not reached the gateway or the index. Handing the same fact back — same `mutationId` —
     * records it without writing the file again. It is idempotent, so a caller may retry freely.
     */
    async recordCommittedMutation(input) {
      if (!rpc.recordCommittedMutation) return null;
      return rpc.recordCommittedMutation(input);
    },
  };
}

export function backlinkTargets(key: string): Set<string> {
  const noExt = key.replace(/\.(md|markdown|mdx|txt)$/i, "");
  const basename = noExt.split("/").pop() ?? noExt;
  return new Set([noExt, basename]);
}

export async function scanTextFiles<T>(
  documents: VaultDocuments,
  prefix: string | undefined,
  fn: (key: string, text: string, document: VaultDocument) => T | null | Promise<T | null>,
  options: { batchSize?: number; max?: number } = {},
): Promise<T[]> {
  const batchSize = options.batchSize ?? 10;
  const max = options.max ?? Infinity;
  const result: T[] = [];
  let cursor: string | undefined;
  outer: do {
    const page = await documents.list({ prefix, cursor, limit: 1000 });
    const keys = page.items.filter(item => isTextDocumentKey(item.key)).map(item => item.key);
    for (let index = 0; index < keys.length; index += batchSize) {
      const values = await Promise.all(keys.slice(index, index + batchSize).map(async key => {
        const document = await documents.get(key);
        return document && fn(key, await document.text(), document);
      }));
      for (const value of values) {
        if (value != null) result.push(value);
        if (result.length >= max) break outer;
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return result;
}
