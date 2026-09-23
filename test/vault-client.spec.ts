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
    deleteDocuments: vi.fn(async () => ({ deleted: ["note.md"], etags: ["E1"], mutations: [{ mutationId: "mut_test", mutationSeq: 1, mutationPending: false }], mutationPending: false })),
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

/**
 * `mutationPending` is a signal, not a dead end.
 *
 * The Vault retries its own repair after the response; this is the other half of the same invariant,
 * at the only place that still holds the fact. The write must never be repeated — R2 already has the
 * bytes — so every retry is a record-only submission of the same mutation id.
 */
describe("Vault RPC client repair", () => {
  const pending = (mutationId: string) => ({ etag: "E1", size: 5, mutationId, mutationSeq: -1, mutationPending: true });

  it("hands a pending put fact back with the same id, once", async () => {
    const binding = rpc();
    binding.putDocument = vi.fn(async () => pending("mut_pending"));
    binding.recordCommittedMutation = vi.fn(async () => ({ recorded: true, seq: 7, attempts: 1 }));
    const vault = createVaultClient(binding);

    await vault.documents.put("note.md", new Uint8Array([1]));

    expect(binding.putDocument).toHaveBeenCalledOnce();
    expect(binding.recordCommittedMutation).toHaveBeenCalledOnce();
    expect(binding.recordCommittedMutation).toHaveBeenCalledWith(expect.objectContaining({ id: "mut_pending", source: "mcp", op: "put", path: "note.md", etag: "E1", size: 5 }));
    expect(vault.pendingMutations()).toEqual([]);
  });

  it("keeps the fact when the record still fails, and lands it on the next write", async () => {
    const binding = rpc();
    // Counted independently of the mock: the point is how many times R2 was written, not which spy
    // happened to be installed at the time.
    const puts: string[] = [];
    binding.putDocument = vi.fn(async (input: { key: string }) => {
      puts.push(input.key);
      return pending(`mut_${input.key}`);
    });
    binding.recordCommittedMutation = vi.fn(async () => ({ recorded: false, attempts: 2 }));
    const failures: string[] = [];
    const vault = createVaultClient(binding, { repairAttempts: 1, onRepairFailed: message => failures.push(message) });

    await vault.documents.put("first.md", new Uint8Array([1]));
    expect(vault.pendingMutations()).toHaveLength(1);
    expect(vault.pendingMutations()[0]).toMatchObject({ id: "mut_first.md", path: "first.md" });
    expect(failures).toHaveLength(1);

    // The journal heals; the next write flushes the earlier fact before doing its own work.
    binding.recordCommittedMutation = vi.fn(async () => ({ recorded: true, seq: 9, attempts: 1 }));
    binding.putDocument = vi.fn(async (input: { key: string }) => {
      puts.push(input.key);
      return { ...pending(`mut_${input.key}`), mutationPending: false };
    });
    await vault.documents.put("second.md", new Uint8Array([2]));

    expect(vault.pendingMutations()).toEqual([]);
    expect(binding.recordCommittedMutation).toHaveBeenCalledWith(expect.objectContaining({ id: "mut_first.md", op: "put", path: "first.md" }));
    // Exactly one R2 write per file, and none for the repair.
    expect(puts).toEqual(["first.md", "second.md"]);
  });

  it("repairs a pending delete per key, with the id the Vault minted", async () => {
    const binding = rpc();
    binding.deleteDocuments = vi.fn(async () => ({
      deleted: ["a.md", "b.md"],
      etags: ["EA", "EB"],
      mutations: [
        { mutationId: "mut_del_a", mutationSeq: -1, mutationPending: true },
        { mutationId: "mut_del_b", mutationSeq: 3, mutationPending: false },
      ],
      mutationPending: true,
    }));
    binding.recordCommittedMutation = vi.fn(async () => ({ recorded: true, seq: 11, attempts: 1 }));
    const vault = createVaultClient(binding);

    await vault.documents.delete(["a.md", "b.md"]);

    expect(binding.recordCommittedMutation).toHaveBeenCalledOnce();
    expect(binding.recordCommittedMutation).toHaveBeenCalledWith(expect.objectContaining({ id: "mut_del_a", op: "delete", path: "a.md", etag: "EA" }));
    expect(vault.pendingMutations()).toEqual([]);
  });

  it("does nothing when the Vault predates the mutation journal", async () => {
    const binding = rpc();
    binding.putDocument = vi.fn(async () => pending("mut_legacy"));
    delete binding.recordCommittedMutation;
    const failures: string[] = [];
    const vault = createVaultClient(binding, { repairAttempts: 1, onRepairFailed: message => failures.push(message) });

    await vault.documents.put("legacy.md", new Uint8Array([1]));

    // The write still succeeded; only the report is impossible, and that is reported as such.
    expect(failures).toEqual(["mutation repair unsupported id=mut_legacy"]);
    expect(vault.recordCommittedMutation({ id: "x", source: "mcp", op: "delete", path: "a.md", committedAt: 1 })).resolves.toBeNull();
  });
});
