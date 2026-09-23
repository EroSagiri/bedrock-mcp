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
import { createVaultService, type VaultDocumentMetadata, type VaultService, type VaultWriteResult } from "./service";import type { VaultIndex } from "./durable/vault-index";
import { createMutationIngress, handleJournalStateRequest, handleMutationIngressRequest } from "./mutation/http";
import { parseCommittedMutation, recordCommittedMutationUntilRecorded, REPAIR_ATTEMPTS, type CommittedMutationInput } from "./mutation/committed";
import { mutationLog } from "./mutation/ids";
import type { MutationRecorder } from "./mutation/recorder";
import type { MutationJournal } from "./mutation/store";
import type { MutationEvent } from "./mutation/types";
import { createGatewayPublisher, type GatewayRpcBinding } from "./sync-publisher/gateway-rpc";
import { drainSyncOutbox } from "./sync-publisher/publisher";
import { drainDueIndex } from "./index/scheduler";

/** The R2 outcome a repair may need to describe, captured at write time. */
type CommittedWrite =
  | { op: "put"; path: string; etag: string; size: number }
  | { op: "delete"; path: string; etag?: string };

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
  /**
   * The one seam that exists for tests: a subclass may supply the journal, so a test can produce the
   * "R2 committed, journal did not" state without pretending the deployed binding is broken.
   */
  protected service(): VaultService {
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
    this.ctx.waitUntil(this.afterWrite(document, { op: "put", path: document.key, etag: document.etag, size: document.size }));
    return { etag: document.etag, size: document.size, mutationId: document.mutationId, mutationSeq: document.mutationSeq, mutationPending: document.mutationPending };
  }

  async deleteDocuments(keys: string | string[]): Promise<DeleteDocumentsResult> {
    const results = await this.service().documents.delete(keys, { source: "mcp" });
    const list = Array.isArray(results) ? results : [results];
    for (const result of list) this.ctx.waitUntil(this.afterWrite(result, { op: "delete", path: result.key, etag: result.etag }));
    return {
      deleted: list.map(result => result.key),
      etags: list.map(result => result.etag ?? null),
      mutations: list.map(result => ({ mutationId: result.mutationId, mutationSeq: result.mutationSeq, mutationPending: result.mutationPending })),
      mutationPending: list.some(result => result.mutationPending),
    };
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
   * Records a fact about an R2 write the Vault already committed.
   *
   * This exists for exactly one caller shape: a writer that saw `mutationPending: true` and wants the
   * change to reach the gateway and the index **without writing the file again**. It is idempotent by
   * `mutationId`, so the same call can be made as often as the writer likes.
   *
   * A malformed submission is answered, not thrown: the caller's bytes are already durable, so this is
   * a report about the *record*, and `recorded: false` is the honest answer. Throwing here would turn
   * a caller's bad input into a transport-level failure of a write that in fact succeeded.
   */
  async recordCommittedMutation(input: CommittedMutationInput): Promise<{ recorded: boolean; seq?: number; attempts: number }> {
    const event = parseCommittedMutation(input);
    if (!event) return { recorded: false, attempts: 0 };
    const repair = await this.repair(this.journal(), this.service().mutations, event);
    if (repair.recorded) this.ctx.waitUntil(this.drainConsumers(repair.seq === undefined ? event.id : undefined));
    return repair;
  }

  /**
   * Retries the record, never the write.
   *
   * A repair that still cannot land is logged and reported as unrecorded rather than thrown, because
   * the R2 change is already durable: nothing about a journal failure may look like a failed write.
   */
  private async repair(journal: MutationJournal, recorder: MutationRecorder, event: MutationEvent): Promise<{ recorded: boolean; seq?: number; attempts: number }> {
    try {
      return await recordCommittedMutationUntilRecorded({ journal, recorder }, event);
    } catch (error) {
      console.error(`mutation repair exhausted id=${event.id} op=${event.op} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      return { recorded: false, attempts: REPAIR_ATTEMPTS };
    }
  }

  /**
   * Everything a committed write still needs, run after the response.
   *
   * A write whose journal record failed is **not** left to a future manual `refresh()`: the repair
   * retries the same `mutationId` until the fact lands. Only then can the gateway and the index see it.
   */
  private async afterWrite(written: { mutationId: string; mutationPending: boolean }, committed: CommittedWrite): Promise<void> {
    if (written.mutationPending) {
      const event: MutationEvent = {
        id: written.mutationId,
        source: "mcp",
        committedAt: Date.now(),
        ...(committed.op === "put"
          ? { op: "put" as const, path: committed.path, etag: committed.etag!, size: committed.size ?? 0 }
          : { op: "delete" as const, path: committed.path, etag: committed.etag }),
      };
      const repair = await this.repair(this.journal(), this.service().mutations, event);
      if (!repair.recorded) return;
    }
    await this.drainConsumers(written.mutationId);
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
   *
   * Because a channel is a digest, a *wrong* namespace does not fail — it silently publishes to a
   * channel no client subscribes to. The one value that is guaranteed wrong is wrangler.jsonc's
   * placeholder, so it is treated as "not configured at all" and the publisher reports itself
   * disabled instead of digesting a namespace that nobody uses.
   */
  private async gatewayChannel(): Promise<string | null> {
    const endpoint = this.env.MINERAL_R2_ENDPOINT;
    const bucket = this.env.MINERAL_BUCKET;
    if (!endpoint || !bucket) return null;
    if (!/^https?:\/\//i.test(endpoint) || /(^|\.)example\.r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname)) {
      mutationLog("mutation broadcast channel unconfigured", {});
      return null;
    }
    const { deriveRemoteChangeChannel } = await import("@mineral/sync-core/channel");
    return deriveRemoteChangeChannel({ endpoint, bucket, remotePrefix: this.env.MINERAL_REMOTE_PREFIX ?? "" });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/journal" && request.method === "GET") {
      const namespace = this.env.VAULT_INDEX;
      return handleJournalStateRequest(request, this.env, async () => {
        const stub = namespace.get(namespace.idFromName("vault")) as unknown as VaultIndex;
        return stub.journalState();
      });
    }
    if (url.pathname !== "/internal/mutations" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const ingress = createMutationIngress(this.env, this.journal(), this.service().mutations);
    const outcome = await handleMutationIngressRequest(request, this.env, ingress);
    // A reported fact owes the same follow-through as a Vault-performed write: broadcast and index it.
    // The drain runs after the response, so the caller's 202 still means "durable", not "delivered" —
    // and an ingress report does not sit in the journal until the next cron tick.
    if (outcome.recorded) this.ctx.waitUntil(this.drainConsumers(outcome.mutationId));
    return outcome.response;
  }
}
