import { describe, expect, it, vi } from "vitest";
import { createVaultClient } from "../apps/mcp/src/vault-client";
import type { VaultRpc } from "@mineral/core/vault-rpc";

function rpc(): VaultRpc {
  return {
    getDocument: vi.fn(async key => key === "missing" ? null : ({
      key,
      size: 2,
      modified: "2026-09-20T00:00:00.000Z",
      uploaded: "2026-09-20T00:00:00.000Z",
      contentType: "text/markdown",
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: null,
      bytes: new TextEncoder().encode("ok"),
    })),
    headDocument: vi.fn(async () => null),
    listDocuments: vi.fn(async () => ({ items: [], objects: [], cursor: null, truncated: false })),
    putDocument: vi.fn(async () => ({ etag: "E1", size: 1, mutationId: "mut_test", mutationSeq: 1, mutationPending: false })),
    deleteDocuments: vi.fn(async () => ({ deleted: ["note.md"], etags: ["E1"], mutationPending: false })),
    backupTextDocument: vi.fn(async () => ".history/example/note.md"),
    moveDocument: vi.fn(async () => undefined),
    queryIndex: vi.fn(async () => ({ source: "index" })),
    refreshIndex: vi.fn(async () => ({ accepted: true })),
  };
}

describe("Vault RPC client", () => {
  it("adapts the stable RPC DTOs without exposing storage bindings", async () => {
    const binding = rpc();
    const vault = createVaultClient(binding);

    const document = await vault.documents.get("note.md");
    expect(await document?.text()).toBe("ok");
    expect(document?.uploaded).toBeInstanceOf(Date);
    await vault.documents.put("note.md", new Uint8Array([1]), { httpMetadata: { contentType: "text/markdown" } });
    await vault.documents.delete("note.md");
    await vault.documents.backupText("note.md", "text");
    await vault.documents.move("from.md", "to.md");
    await vault.index.query("stats", {});
    await vault.index.refresh();

    expect(binding.putDocument).toHaveBeenCalledWith({ key: "note.md", bytes: new Uint8Array([1]), contentType: "text/markdown", customMetadata: undefined });
    expect(binding.deleteDocuments).toHaveBeenCalledWith("note.md");
    expect(binding.backupTextDocument).toHaveBeenCalledWith("note.md", "text", undefined);
    expect(binding.moveDocument).toHaveBeenCalledWith("from.md", "to.md");
    expect(binding.queryIndex).toHaveBeenCalledWith("stats", {});
    expect(binding.refreshIndex).toHaveBeenCalledOnce();
  });
});
