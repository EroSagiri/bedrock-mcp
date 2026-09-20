import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ListDocumentsInput,
  ListDocumentsResult,
  PutDocumentInput,
  VaultRpcDocument,
  VaultRpcDocumentMetadata,
} from "@mineral/core/vault-rpc";
import { createVaultService, type VaultDocumentMetadata } from "./service";
import type { VaultIndex } from "./durable/vault-index";

// The destination Worker must ship this class when it receives the existing
// VaultIndex namespace through a legacy transfer migration.
export { VaultIndex } from "./durable/vault-index";

export type VaultWorkerEnv = {
  MINERAL: R2Bucket;
  VAULT_INDEX: DurableObjectNamespace<VaultIndex>;
};

function toRpcMetadata(metadata: VaultDocumentMetadata): VaultRpcDocumentMetadata {
  return { ...metadata, uploaded: metadata.uploaded.toISOString() };
}

/** Thin RPC adapter. VaultService remains the single business implementation. */
export default class VaultEntrypoint extends WorkerEntrypoint<VaultWorkerEnv> {
  private service() {
    return createVaultService(this.env);
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

  async putDocument(input: PutDocumentInput): Promise<void> {
    await this.service().documents.put(input);
  }

  async deleteDocuments(keys: string | string[]): Promise<void> {
    await this.service().documents.delete(keys);
  }

  async backupTextDocument(key: string, text: string, contentType?: string): Promise<string> {
    return this.service().documents.backupText(key, text, contentType);
  }

  async moveDocument(from: string, to: string): Promise<void> {
    await this.service().documents.move(from, to);
  }

  async queryIndex(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service().index.query(kind, input);
  }

  async refreshIndex(): Promise<Record<string, unknown>> {
    return this.service().index.refresh();
  }

  async scheduled(_controller: ScheduledController): Promise<void> {
    this.ctx.waitUntil(this.service().index.refresh());
  }

  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
}
