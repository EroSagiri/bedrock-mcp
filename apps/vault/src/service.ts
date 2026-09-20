import type { VaultIndex } from "./durable/vault-index";
import { textContentTypeForKey } from "@mineral/core/content";

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
export type ListDocumentsInput = { prefix?: string; cursor?: string; limit?: number; include?: string[] };
export type ListDocumentsResult = { items: VaultDocumentMetadata[]; objects: VaultDocumentMetadata[]; cursor: string | null; truncated: boolean };

/**
 * Transitional in-process document port. Its concrete R2 implementation is
 * confined to Vault; callers depend on this named port rather than a binding.
 */
export type VaultDocuments = {
  get(key: string): Promise<VaultDocument | null>;
  metadata(key: string): Promise<VaultDocumentMetadata | null>;
  head(key: string): Promise<VaultDocumentMetadata | null>;
  list(input?: ListDocumentsInput): Promise<ListDocumentsResult>;
  put(input: PutDocumentInput): Promise<void>;
  put(key: string, bytes: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  backupText(key: string, text: string, contentType?: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
};

export type VaultIndexService = {
  query(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refresh(): Promise<Record<string, unknown>>;
};

export type VaultService = {
  documents: VaultDocuments;
  index: VaultIndexService;
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

export function createVaultService(env: VaultEnv): VaultService {
  const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault"));
  return {
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
      async head(key) { return this.metadata(key); },
      async list(input = {}) {
        const page = await env.MINERAL.list({
          prefix: input.prefix,
          cursor: input.cursor,
          limit: input.limit,
          include: ["httpMetadata", "customMetadata"],
        });
        const items = page.objects.map(metadata);
        return { items, objects: items, cursor: page.truncated ? page.cursor ?? null : null, truncated: page.truncated };
      },
      async put(inputOrKey: PutDocumentInput | string, bytes?: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
        const input = typeof inputOrKey === "string" ? { key: inputOrKey, bytes: bytes!, contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata } : inputOrKey;
        await env.MINERAL.put(input.key, input.bytes, {
          httpMetadata: input.contentType ? { contentType: input.contentType } : undefined,
          customMetadata: input.customMetadata,
        });
      },
      async delete(keys) { await env.MINERAL.delete(keys); },
      async backupText(key, text, contentType) {
        const backupKey = `.history/${new Date().toISOString().replace(/[:.]/g, "-")}/${key}`;
        await env.MINERAL.put(backupKey, new TextEncoder().encode(text), {
          httpMetadata: { contentType: textContentTypeForKey(key, contentType) },
          customMetadata: { sourceKey: key, createdAt: new Date().toISOString() },
        });
        return backupKey;
      },
      async move(from, to) {
        const source = await env.MINERAL.get(from);
        if (!source) throw new Error(`Not found: ${from}`);
        await env.MINERAL.put(to, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
        await env.MINERAL.delete(from);
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
      async refresh() {
        const response = await stub.fetch("https://vault-index/refresh", { method: "POST", body: "{}" });
        if (!response.ok) throw new Error(`Vault index refresh failed: ${response.status}`);
        return response.json<Record<string, unknown>>();
      },
    },
  };
}
