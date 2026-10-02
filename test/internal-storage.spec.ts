import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { isSystemStorageKey, versionKey, versionSourcePath } from "@mineral/sync-core/storage";
import { tombstoneKey, tombstoneReadKeys } from "@mineral/sync-core/tombstones";
import { isIndexable } from "../apps/vault/src/index/indexable";
import { normalizeStaticPrefix, verifyStaticAccessToken, createStaticAccessToken } from "../apps/mcp/src/auth/static-token";
import { createHotCheckpoint } from "../apps/vault/src/hot/checkpoint";
import { createVaultService } from "../apps/vault/src/service";
import { registerDocumentTools } from "../apps/mcp/src/mcp/tools/documents";
import { registerFileTools } from "../apps/mcp/src/mcp/tools/files";
import type { McpRegistrationContext } from "../apps/mcp/src/mcp/shared";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore } from "../apps/vault/src/mutation/store";
import { bindings } from "./support";

describe("shared internal storage", () => {
  it("archives hot deletion before removing the source and keeps retries idempotent", async () => {
    const bucket = bindings().MINERAL;
    const path = "internal-storage/recycle-hot.md";
    const source = await bucket.put(path, "recoverable", { customMetadata: { title: "original" } });
    const checkpoint = createHotCheckpoint({ bucket, prefix: "", record: async () => ({ seq: 1, pending: false }) });
    const input = { canonicalPath: path, documentId: "recycle", epoch: 1, commitId: "delete-1", expectedRemoteETag: source!.etag };
    expect((await checkpoint.remove(input)).status).toBe("deleted");
    expect(await bucket.head(path)).toBeNull();
    const copies = (await bucket.list({ prefix: ".mineral/versions/" })).objects.filter(object => object.key.endsWith(`/${path}`));
    expect(copies).toHaveLength(1);
    const copy = await bucket.get(copies[0]!.key);
    expect(await copy!.text()).toBe("recoverable");
    expect(copy!.customMetadata?.reason).toBe("delete");
    expect(JSON.parse(copy!.customMetadata!.mineralOriginalMetadata!)).toEqual({ title: "original" });
    await checkpoint.remove(input);
    expect((await bucket.list({ prefix: ".mineral/versions/" })).objects.filter(object => object.key.endsWith(`/${path}`))).toHaveLength(1);
  });

  it("routes batch soft deletion into the same version store", async () => {
    const documents = createVaultService(bindings(), { journal: journalFromStore(new MemoryMutationStore()) }).documents;
    const key = "internal-storage/batch.md";
    await documents.put({ key, bytes: new TextEncoder().encode("batch") });
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = { registerTool: (name: string, _config: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) => { handlers.set(name, callback); return {}; } } as unknown as McpServer;
    registerFileTools({ server, env: { vault: { documents } } } as unknown as McpRegistrationContext);
    await handlers.get("file_delete_many")!({ keys: [key] });
    expect(await documents.head(key)).toBeNull();
    const entries = await documents.list({ prefix: ".mineral/versions/" });
    const copy = entries.items.find(item => item.customMetadata?.sourceKey === key);
    expect(copy?.customMetadata?.reason).toBe("delete");
    expect(await (await documents.get(copy!.key))?.text()).toBe("batch");
  });
  it("keeps versions outside indexes and static-token access", async () => {
    const key = versionKey("附件/photo.png");
    expect(key.startsWith(".mineral/versions/")).toBe(true);
    expect(versionSourcePath(key)).toBe("附件/photo.png");
    expect(versionSourcePath(".history/time/note.md")).toBe("note.md");
    expect(versionSourcePath(".trash/time/note.md")).toBe("note.md");
    expect(versionSourcePath(".mineral/versions/broken")).toBeUndefined();
    const issued = await createStaticAccessToken("secret", "", 600, 1000);
    for (const path of [key, ".mineral/versions/time/note.md", ".mineral/tombstones/record.json", ".mineral", ".trash/time/note.md"]) {
      expect(isSystemStorageKey(path)).toBe(true);
      expect(isIndexable(path)).toBe(false);
      expect(normalizeStaticPrefix(path)).toBeNull();
      expect(await verifyStaticAccessToken(issued.token, "secret", path, 1100)).toBe(false);
    }
  });

  it("stores both backup and delete copies in versions and preserves binary content", async () => {
    const documents = createVaultService(bindings(), { journal: journalFromStore(new MemoryMutationStore()) }).documents;
    const key = "internal-storage/photo.png";
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    await documents.put({ key, bytes, contentType: "image/png", customMetadata: { owner: "example", sourceKey: "user-field" } });
    const destination = versionKey(key);
    await documents.move(key, destination);
    expect(await documents.get(key)).toBeNull();
    const copy = await documents.get(destination);
    expect(copy?.bytes).toEqual(bytes);
    expect(copy?.contentType).toBe("image/png");
    expect(copy?.customMetadata).toMatchObject({ sourceKey: key, reason: "delete" });
    expect(JSON.parse(copy!.customMetadata!.mineralOriginalMetadata)).toEqual({ owner: "example", sourceKey: "user-field" });
    const backup = await documents.backupText("internal-storage/note.md", "before");
    expect(backup.startsWith(".mineral/versions/")).toBe(true);
    expect((await documents.get(backup))?.customMetadata?.reason).toBe("backup");
  });

  it("still observes legacy deletion records before migration", async () => {
    const bucket = bindings().MINERAL;
    const path = "internal-storage/deleted.md";
    const object = await bucket.put(path, "deleted content");
    const keys = await tombstoneReadKeys(path, object!.etag);
    expect(keys[0]).toBe(await tombstoneKey(path, object!.etag));
    expect(keys[1].startsWith(".mineral-sync/tombstones/")).toBe(true);
    await bucket.put(keys[1], JSON.stringify({ protocol: 1, path, deletedRemoteETag: object!.etag, createdAt: new Date().toISOString() }));
    const checkpoint = createHotCheckpoint({ bucket, prefix: "", record: async () => ({ seq: 1, pending: false }) });
    expect((await checkpoint.observe(path, false)).observation).toMatchObject({ exists: false, deleted: true });
  });

  it("restores binary versions without decoding bytes or losing user metadata", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = { registerTool: (name: string, _config: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) => { handlers.set(name, callback); return {}; } } as unknown as McpServer;
    const bytes = new Uint8Array([0, 255, 128]);
    const put = vi.fn(async () => ({}));
    const context = {
      server,
      env: { vault: { documents: {
        head: async () => null,
        get: async () => ({ bytes, httpMetadata: { contentType: "image/png" }, customMetadata: { reason: "delete", sourceKey: "image.png", mineralOriginalMetadata: JSON.stringify({ sourceKey: "user-field", owner: "example" }) } }),
        put,
      } } },
    } as unknown as McpRegistrationContext;
    registerDocumentTools(context);
    await handlers.get("doc_restore")!({ backupKey: ".mineral/versions/time/image.png" });
    expect(put).toHaveBeenCalledWith("image.png", bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: { sourceKey: "user-field", owner: "example" } });
    put.mockClear();
    await handlers.get("doc_restore")!({ backupKey: ".mineral/versions/time/image.png", targetKey: ".mineral/versions/another.png" });
    expect(put).not.toHaveBeenCalled();
  });
});
