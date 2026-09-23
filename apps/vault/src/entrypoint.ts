import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  DeleteDocumentsResult,
  ListDocumentsInput,
  ListDocumentsResult,
  PutDocumentInput,
  PutDocumentResult,
  VaultRpcDocument,
  VaultRpcDocumentMetadata,
} from "@mineral/core/vault-rpc";
import { createVaultService, type VaultDocumentMetadata } from "./service";
import type { VaultIndex } from "./durable/vault-index";
import { createMutationIngress, handleMutationIngressRequest } from "./mutation/http";
import type { MutationJournal } from "./mutation/store";
import { createGatewayPublisher, type GatewayRpcBinding } from "./sync-publisher/gateway-rpc";
import { drainSyncOutbox } from "./sync-publisher/publisher";
import { drainDueIndex } from "./index/scheduler";

// The destination Worker must ship this class when it receives the existing
// VaultIndex namespace through a legacy transfer migration.
export { VaultIndex } from "./durable/vault-index";

export type VaultWorkerEnv = {
  MINERAL: R2Bucket;
  VAULT_INDEX: DurableObjectNamespace<VaultIndex>;
  MUTATION_INGRESS_TOKEN?: string;
  SYNC_GATEWAY?: GatewayRpcBinding;
  SYNC_GATEWAY_URL?: string;
  SYNC_GATEWAY_TOKEN?: string;
  MINERAL_R2_ENDPOINT?: string;
  MINERAL_BUCKET?: string;
  MINERAL_REMOTE_PREFIX?: string;
  INDEXING_ENABLED?: string;
};

function toRpcMetadata(metadata: VaultDocumentMetadata): VaultRpcDocumentMetadata {
  return { ...metadata, uploaded: metadata.uploaded.toISOString() };
}

/**
 * Thin RPC adapter. VaultService remains the single business implementation.
 *
 * The RPC surface deliberately exposes **no** way to announce a change: a caller writes, and Vault
 * records the mutation itself. That is what makes MCP, web, and any future writer indistinguishable
 * to the Sync Publisher and the Index Scheduler.
 */
export default class VaultEntrypoint extends WorkerEntrypoint<VaultWorkerEnv> {
  private service() {
    return createVaultService(this.env);
  }

  private journal(): MutationJournal {
    return this.env.VAULT_INDEX.get(this.env.VAULT_INDEX.idFromName("vault")) as unknown as MutationJournal;
  }

  async getDocument(key: string): Promise<VaultRpcDocument | null> {
    const document = await this.service().documents.get(key);
    return document && { ...toRpcMetadata(document), bytes: document.bytes };
  }

  async headDocument(key: string): Promise<VaultRpcDocumentMetadata | null> {
    const document = await this.service().documents.head(key);
    return document && toRpcMetadata(document);
  }

  async listDocuments(input?: ListDocumentsInput): Promise<ListDocumentsResult> {
    const result = await this.service().documents.list(input);
    const items = result.items.map(toRpcMetadata);
    return { ...result, items, objects: items };
  }

  async putDocument(input: PutDocumentInput): Promise<PutDocumentResult> {
    const document = await this.service().documents.put(input, { source: "mcp" });
    this.ctx.waitUntil(this.drainConsumers(document.mutationId));
    return { etag: document.etag, size: document.size, mutationId: document.mutationId, mutationSeq: document.mutationSeq, mutationPending: document.mutationPending };
  }

  async deleteDocuments(keys: string | string[]): Promise<DeleteDocumentsResult> {
    const results = await this.service().documents.delete(keys, { source: "mcp" });
    const list = Array.isArray(results) ? results : [results];
    for (const result of list) this.ctx.waitUntil(this.drainConsumers(result.mutationId));
    return { deleted: list.map(result => result.key), mutationPending: list.some(result => result.mutationPending) };
  }

  async backupTextDocument(key: string, text: string, contentType?: string): Promise<string> {
    return this.service().documents.backupText(key, text, contentType, { source: "system" });
  }

  async moveDocument(from: string, to: string): Promise<void> {
    await this.service().documents.move(from, to, { source: "mcp" });
    this.ctx.waitUntil(this.drainConsumers());
  }

  async queryIndex(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service().index.query(kind, input);
  }

  async refreshIndex(): Promise<Record<string, unknown>> {
    return this.service().index.refresh();
  }

  async scheduled(_controller: ScheduledController): Promise<void> {
    this.ctx.waitUntil(this.drainConsumers());
  }

  /**
   * The consumers are fire-and-forget from the writer's point of view.
   *
   * Both are idempotent and both are driven by the journal: a gateway outage only leaves entries
   * pending, and an index failure only leaves intents dirty. Neither can change the response the
   * writer already received.
   */
  private async drainConsumers(mutationId?: string): Promise<void> {
    const journal = this.journal();
    const gateway = createGatewayPublisher({
      channel: await this.gatewayChannel(),
      ...(this.env.SYNC_GATEWAY ? { rpc: this.env.SYNC_GATEWAY } : {}),
      ...(this.env.SYNC_GATEWAY_URL ? { url: this.env.SYNC_GATEWAY_URL } : {}),
      ...(this.env.SYNC_GATEWAY_TOKEN ? { token: this.env.SYNC_GATEWAY_TOKEN } : {}),
    });
    try {
      await drainSyncOutbox({ journal, gateway });
    } catch (error) {
      console.error(`sync outbox drain failed id=${mutationId ?? ""} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }
    if (this.env.INDEXING_ENABLED === "false") return;
    try {
      const namespace = this.env.VAULT_INDEX;
      const indexer = {
        async apply(intent: { path: string; action: "upsert" | "remove" }) {
          const stub = namespace.get(namespace.idFromName("vault")) as unknown as VaultIndex;
          return stub.applyIndexIntent(intent);
        },
      };
      await drainDueIndex({ journal, indexer });
    } catch (error) {
      console.error(`index drain failed id=${mutationId ?? ""} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }
  }

  /**
   * The gateway channel is derived, never configured: it must equal the channel the Obsidian
   * clients compute from the same R2 namespace, or the broadcast reaches nobody.
   */
  private async gatewayChannel(): Promise<string | null> {
    const endpoint = this.env.MINERAL_R2_ENDPOINT;
    const bucket = this.env.MINERAL_BUCKET;
    if (!endpoint || !bucket) return null;
    const { deriveRemoteChangeChannel } = await import("@mineral/sync-core/channel");
    return deriveRemoteChangeChannel({ endpoint, bucket, remotePrefix: this.env.MINERAL_REMOTE_PREFIX ?? "" });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/internal/mutations" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const ingress = createMutationIngress(this.env, this.journal(), this.service().mutations);
    return handleMutationIngressRequest(request, this.env, ingress);
  }
}
