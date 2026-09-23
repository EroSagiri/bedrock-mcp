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
  /** Facts this client has not managed to get recorded yet. Diagnostics and tests only. */
  pendingMutations(): CommittedMutationInput[];
  /** Re-submits every outstanding fact. Never writes R2 — a fact is recorded, never re-executed. */
  flushOutstanding(): Promise<void>;
};

function metadata(document: VaultRpcDocumentMetadata): VaultDocumentMetadata {
  return { ...document, uploaded: new Date(document.uploaded) };
}

/**
 * A write's report about its own mutation record.
 *
 * `mutationPending` means the bytes are durable in R2 but the fact did not reach the journal, so the
 * gateway and the index have not been told. The write succeeded; the record is outstanding.
 */
type MutationRecordReport = { mutationId: string; mutationPending: boolean };

/** How many times the client re-submits an outstanding fact on top of the Vault's own repair. */
const REPAIR_ATTEMPTS = 2;
const REPAIR_BACKOFF_MS = 250;

export type VaultClientDependencies = {
  /** Called once per fact the client could not get recorded. Diagnostics, never control flow. */
  onRepairFailed?(message: string): void;
  repairAttempts?: number;
};

export function createVaultClient(rpc: VaultRpc, dependencies: VaultClientDependencies = {}): VaultClient {
  const attempts = dependencies.repairAttempts ?? REPAIR_ATTEMPTS;
  /**
   * Facts this client could not get recorded.
   *
   * The Vault retries its own repair after the response, and this is the second half of the same
   * invariant at the only place that still holds the information: the caller. A command leaves them
   * here; a later write flushes them before doing anything else. Nothing here ever writes R2 — a fact
   * is re-submitted, never re-executed.
   */
  const outstanding = new Map<string, CommittedMutationInput>();

  async function submit(fact: CommittedMutationInput): Promise<boolean> {
    if (!rpc.recordCommittedMutation) {
      dependencies.onRepairFailed?.(`mutation repair unsupported id=${fact.id}`);
      return false;
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const recorded = await rpc.recordCommittedMutation(fact);
        if (recorded?.recorded !== false) {
          outstanding.delete(fact.id);
          return true;
        }
      } catch {
        // A transport failure says nothing about whether the fact landed; the id makes a retry safe.
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, REPAIR_BACKOFF_MS));
    }
    outstanding.set(fact.id, fact);
    dependencies.onRepairFailed?.(`mutation repair outstanding id=${fact.id} pending=${outstanding.size}`);
    return false;
  }

  /** The second half of `mutationPending`: the caller hands the fact back instead of writing again. */
  async function repairAfterWrite(report: MutationRecordReport, fact: Omit<CommittedMutationInput, "id" | "committedAt">): Promise<void> {
    if (!report.mutationPending) return;
    // The fact keeps the write's own time, so a debounce window is measured from the write.
    await submit({ ...fact, id: report.mutationId, committedAt: Date.now() } as CommittedMutationInput);
  }

  async function flushOutstanding(): Promise<void> {
    for (const fact of [...outstanding.values()]) await submit(fact);
  }

  return {
    /** Facts still waiting for the journal. Test and diagnostic surface only. */
    pendingMutations: () => [...outstanding.values()],
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
        // A write is the natural moment to make good on an earlier outstanding fact.
        await flushOutstanding();
        const written = await rpc.putDocument(input);
        await repairAfterWrite(written, { source: "mcp", op: "put", path: input.key, etag: written.etag, size: written.size });
        return written;
      },
      async delete(keys) {
        await flushOutstanding();
        const deleted = await rpc.deleteDocuments(keys);
        await Promise.all(deleted.deleted.map(async (key, index) => {
          const reference = deleted.mutations[index];
          if (!reference?.mutationPending) return;
          // The same fact, with the id the Vault minted before the delete: the file is already gone,
          // so this records the removal and never re-runs it.
          await submit({
            id: reference.mutationId,
            source: "mcp",
            op: "delete",
            path: key,
            ...(deleted.etags[index] ? { etag: deleted.etags[index]! } : {}),
            committedAt: Date.now(),
          });
        }));
        return deleted;
      },
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
    flushOutstanding,
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
