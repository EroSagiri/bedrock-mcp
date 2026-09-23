import type { VaultIndex } from "./durable/vault-index";
import { textContentTypeForKey } from "@mineral/core/content";
import { createMutationRecorder, type MutationRecorder } from "./mutation/recorder";
import { createMutationId } from "./mutation/ids";
import type { CommittedMutationInput } from "./mutation/committed";
import type { MutationJournal } from "./mutation/store";
import type { MutationSource } from "./mutation/types";

export type VaultDocumentMetadata = {
  key: string;
  size: number;
  modified: string;
  uploaded: Date;
  contentType: string | null;
  httpMetadata: { contentType?: string } | null;
  customMetadata: Record<string, string> | null;
};

export type VaultDocument = VaultDocumentMetadata & {
  bytes: Uint8Array;
  body: Uint8Array;
  httpMetadata: { contentType?: string } | null;
  text(): Promise<string>;
};

export type PutDocumentInput = {
  key: string;
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
};

/**
 * What a committed write reports back.
 *
 * The revision is the point: a writer may report the mutation it just caused, and the journal's
 * idempotency key rides along so a retry is free.
 */
export type VaultWriteResult = {
  key: string;
  etag: string;
  size: number;
  mutationId: string;
  mutationSeq: number;
  /** `true` when R2 committed but the journal fact could not be written. Never silent. */
  mutationPending: boolean;
};

export type VaultDeleteResult = {
  key: string;
  /** The revision that was removed, when the object still existed. Repair needs it; indexing does not. */
  etag?: string;
  mutationId: string;
  mutationSeq: number;
  mutationPending: boolean;
};

export type ListDocumentsInput = { prefix?: string; cursor?: string; limit?: number; include?: string[] };
export type ListDocumentsResult = { items: VaultDocumentMetadata[]; objects: VaultDocumentMetadata[]; cursor: string | null; truncated: boolean };

/**
 * The source a caller claims for its writes, plus the idempotency key a repair will need.
 *
 * `id` exists for the one case where it matters: the fact must be identifiable **before** the journal
 * write is attempted, so that a failed record can be retried with the same key instead of inventing a
 * second one. Callers that do not supply it get a generated key, which is the normal case.
 */
export type VaultWriteOptions = { source?: MutationSource; id?: string };

/**
 * Transitional in-process document port. Its concrete R2 implementation is
 * confined to Vault; callers depend on this named port rather than a binding.
 *
 * Every mutating method is a **journal entry point**: R2 commits first, then `recordMutation()`.
 * No caller is expected to announce the change itself.
 */
export type VaultDocuments = {
  get(key: string): Promise<VaultDocument | null>;
  metadata(key: string): Promise<VaultDocumentMetadata | null>;
  head(key: string): Promise<VaultDocumentMetadata | null>;
  list(input?: ListDocumentsInput): Promise<ListDocumentsResult>;
  /**
   * Both the structured form (preferred) and the key/bytes form are accepted, because that is the
   * shape the existing MCP tools already use. Either way this method owns the mutation fact.
   */
  put(inputOrKey: PutDocumentInput | string, bytesOrOptions?: Uint8Array | VaultWriteOptions, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } & VaultWriteOptions): Promise<VaultWriteResult>;
  /** One key yields one fact; many keys yield one fact each. */  delete<Keys extends string | string[]>(keys: Keys, options?: VaultWriteOptions): Promise<Keys extends string ? VaultDeleteResult : VaultDeleteResult[]>;
  backupText(key: string, text: string, contentType?: string, options?: VaultWriteOptions): Promise<string>;
  move(from: string, to: string, options?: VaultWriteOptions): Promise<void>;
};

export type VaultIndexService = {
  query(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Starts a revision audit on the index and returns its state. */
  refresh(): Promise<Record<string, unknown>>;
};

export type VaultService = {
  documents: VaultDocuments;
  index: VaultIndexService;
  /** Exposed so the ingress and the consumers share exactly one recorder instance. */
  mutations: MutationRecorder;
  /** The repair half of a write: record a fact about an R2 change that already happened. */
  recordCommitted(mutation: CommittedMutationInput): Promise<{ mutationId: string; mutationSeq: number; inserted: boolean }>;
};

function metadata(object: R2Object | R2ObjectBody): VaultDocumentMetadata {
  return {
    key: object.key,
    size: object.size,
    modified: object.uploaded.toISOString(),
    uploaded: object.uploaded,
    contentType: object.httpMetadata?.contentType ?? null,
    httpMetadata: object.httpMetadata ?? null,
    customMetadata: object.customMetadata ?? null,
  };
}

type VaultEnv = {
  MINERAL: R2Bucket;
  VAULT_INDEX: DurableObjectNamespace<VaultIndex>;
};

export function createVaultService(env: VaultEnv, options: { journal?: MutationJournal; now?: () => number } = {}): VaultService {
  const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault"));
  const journal: MutationJournal = options.journal ?? (stub as unknown as MutationJournal);
  const nextId = createMutationId;
  const mutations = createMutationRecorder({ journal, nextId, ...(options.now ? { now: options.now } : {}) });

  /**
   * The one place a successful R2 write becomes a mutation fact.
   *
   * If the journal write fails, the R2 write is **not** rolled back and is **not** reported as a
   * failure: the caller is told `mutationPending`, an id is still returned, and the error is logged.
   * A durability problem in the journal is never allowed to rewrite the outcome of the data plane.
   */
  async function record(
    input: Parameters<MutationRecorder["record"]>[0] & { id?: string },
  ): Promise<{ mutationId: string; mutationSeq: number; mutationPending: boolean }> {
    const id = input.id ?? nextId();
    try {
      const recorded = await mutations.record({ ...input, id });
      return { mutationId: recorded.id, mutationSeq: recorded.seq, mutationPending: false };
    } catch (error) {
      // The id is known even though the fact is not, so a repair has a stable key to retry with.
      console.error(`mutation recording incomplete op=${input.op} source=${input.source} id=${id} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      return { mutationId: id, mutationSeq: -1, mutationPending: true };
    }
  }

  return {
    mutations,
    /**
     * Records a fact about an R2 write that **already happened**, without touching R2.
     *
     * This is the repair path, not a write path: it exists so a committed change whose journal record
     * failed can still be recorded later, with the same `mutationId`, and therefore still reach the
     * gateway and the index. It throws when the journal cannot be written, because a caller that
     * asked only for the record must know whether it landed.
     */
    async recordCommitted(mutation: CommittedMutationInput) {
      const recorded = await mutations.record({
        id: mutation.id,
        source: mutation.source,
        committedAt: mutation.committedAt,
        ...(mutation.op === "rename"
          ? { op: "rename" as const, from: mutation.from!, path: mutation.path, etag: mutation.etag, size: mutation.size }
          : mutation.op === "put"
            ? { op: "put" as const, path: mutation.path, etag: mutation.etag!, size: mutation.size ?? 0 }
            : { op: "delete" as const, path: mutation.path, etag: mutation.etag }),
      });
      return { mutationId: recorded.id, mutationSeq: recorded.seq, inserted: recorded.inserted };
    },
    documents: {
      async get(key) {
        const object = await env.MINERAL.get(key);
        if (!object) return null;
        const bytes = new Uint8Array(await object.arrayBuffer());
        return { ...metadata(object), bytes, body: bytes, httpMetadata: object.httpMetadata ?? null, text: async () => new TextDecoder().decode(bytes) };
      },
      async metadata(key) {
        const object = await env.MINERAL.head(key);
        return object ? metadata(object) : null;
      },
      async head(key) { return this.metadata(key); },      async list(input = {}) {
        const page = await env.MINERAL.list({
          prefix: input.prefix,
          cursor: input.cursor,
          limit: input.limit,
          include: ["httpMetadata", "customMetadata"],
        });
        const items = page.objects.map(metadata);
        return { items, objects: items, cursor: page.truncated ? page.cursor ?? null : null, truncated: page.truncated };
      },
      async put(inputOrKey: PutDocumentInput | string, bytesOrOptions?: Uint8Array | VaultWriteOptions, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } & VaultWriteOptions) {
        const bytes = bytesOrOptions instanceof Uint8Array ? bytesOrOptions : undefined;
        const write = (bytesOrOptions instanceof Uint8Array ? options : bytesOrOptions) as ({ httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } & VaultWriteOptions) | undefined;
        const input: PutDocumentInput = typeof inputOrKey === "string"
          ? { key: inputOrKey, bytes: bytes!, contentType: write?.httpMetadata?.contentType, customMetadata: write?.customMetadata }
          : inputOrKey;
        const source: MutationSource = (typeof inputOrKey === "string" ? write?.source : undefined) ?? "mcp";
        const id = typeof inputOrKey === "string" ? write?.id : undefined;
        const object = await env.MINERAL.put(input.key, input.bytes, {
          httpMetadata: input.contentType ? { contentType: input.contentType } : undefined,
          customMetadata: input.customMetadata,
        });
        const recorded = await record({ source, op: "put", path: input.key, etag: object.etag, size: object.size, ...(id ? { id } : {}) });
        return { key: input.key, etag: object.etag, size: object.size, ...recorded };
      },
      async delete<Keys extends string | string[]>(keys: Keys, options?: VaultWriteOptions) {
        const list = (typeof keys === "string" ? [keys] : keys) as string[];
        const source: MutationSource = options?.source ?? "mcp";
        // The revision is read before the delete so a repair can still describe what was removed.
        const revisions = await Promise.all(list.map(async key => (await env.MINERAL.head(key))?.etag));
        await env.MINERAL.delete(list);
        const results = await Promise.all(list.map(async (key, index) => {
          const recorded = await record({ source, op: "delete", path: key, ...(revisions[index] ? { etag: revisions[index]! } : {}) });
          return { key, ...(revisions[index] ? { etag: revisions[index]! } : {}), ...recorded };
        }));        return (typeof keys === "string" ? results[0] : results) as Keys extends string ? VaultDeleteResult : VaultDeleteResult[];
      },
      async backupText(key, text, contentType, options) {
        const backupKey = `.history/${new Date().toISOString().replace(/[:.]/g, "-")}/${key}`;
        const bytes = new TextEncoder().encode(text);
        const object = await env.MINERAL.put(backupKey, bytes, {
          httpMetadata: { contentType: textContentTypeForKey(key, contentType) },
          customMetadata: { sourceKey: key, createdAt: new Date().toISOString() },
        });
        await record({ source: options?.source ?? "system", op: "put", path: backupKey, etag: object.etag, size: object.size });
        return backupKey;
      },
      async move(from, to, options) {
        const source = await env.MINERAL.get(from);
        if (!source) throw new Error(`Not found: ${from}`);
        const bytes = new Uint8Array(await source.arrayBuffer());
        const object = await env.MINERAL.put(to, bytes, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
        await record({ source: options?.source ?? "mcp", op: "put", path: to, etag: object.etag, size: object.size });
        await env.MINERAL.delete(from);
        await record({ source: options?.source ?? "mcp", op: "delete", path: from });
      },
    },
    index: {
      async query(kind, input) {
        const response = await stub.fetch("https://vault-index/query", {
          method: "POST",
          body: JSON.stringify({ kind, ...input }),
        });
        if (!response.ok) throw new Error(`Vault index query failed: ${response.status}`);
        return response.json<Record<string, unknown>>();
      },
      /**
       * Starts a revision audit, or reports the one already running.
       *
       * There is no generation to rebuild any more: an audit lists R2, diffs it against the live index,
       * and enqueues the difference for the indexer. It writes no index rows itself.
       */
      async refresh() {
        const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault")) as unknown as VaultIndex;
        return stub.startIndexAudit(Date.now());
      },
    },
  };
}

