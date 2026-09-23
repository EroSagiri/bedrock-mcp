import { bindings } from "./support";
import { describe, expect, it } from "vitest";
import { createVaultService } from "../apps/vault/src/service";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore, type MutationJournal } from "../apps/vault/src/mutation/store";
import { createMutationIngress } from "../apps/vault/src/mutation/http";
import { drainSyncOutbox } from "../apps/vault/src/sync-publisher/publisher";
import { drainDueIndex, type NoteIndexer } from "../apps/vault/src/index/scheduler";
import type { GatewayPublisher } from "../apps/vault/src/sync-publisher/gateway-port";
import type { RemoteChange } from "@mineral/sync-core/sync-change";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function countingGateway() {
  const changes: RemoteChange[][] = [];
  let generation = 0;
  const publisher: GatewayPublisher = {
    async publish(event) {
      changes.push(event.op === "delete" ? [{ op: "delete", path: event.path }] : [{ op: "put", path: event.path, etag: event.etag, size: event.size }]);
      return { ok: true, generation: String(++generation) };
    },
  };
  return { changes, publisher, generations: () => generation };
}

function recordingIndexer() {
  const calls: Array<{ path: string; action: string }> = [];
  const indexer: NoteIndexer = {
    async apply(intent) {
      calls.push({ path: intent.path, action: intent.action });
      return { applied: true, indexedEtag: intent.action === "remove" ? null : "live" };
    },
  };
  return { calls, indexer };
}

/** The Vault's real service, backed by the real R2 bucket, with both consumers on the journal. */
function vaultFor(journal: MutationJournal, gateway: GatewayPublisher) {
  return {
    service: createVaultService(bindings(), { journal }),
    consume: async (indexer: NoteIndexer) => ({
      outbox: await drainSyncOutbox({ journal, gateway }),
      index: await drainDueIndex({ journal, indexer }),
    }),
  };
}

describe("Mutation bus: MCP write", () => {
  it("writes R2, records one fact, broadcasts to the gateway, and owes one index intent", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const gateway = countingGateway();
    const indexer = recordingIndexer();
    const vault = vaultFor(journal, gateway.publisher);

    const written = await vault.service.documents.put(
      { key: "bus/mcp-note.md", bytes: encoder.encode("# from mcp\n"), contentType: "text/markdown" },
      { source: "mcp" },
    );

    // The write reports its revision and the fact that records it.
    expect(written).toMatchObject({ key: "bus/mcp-note.md", mutationPending: false });
    expect(written.etag).toBeTruthy();
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(store.snapshotJournal()[0]).toMatchObject({ id: written.mutationId, source: "mcp", op: "put", path: "bus/mcp-note.md", broadcastState: "pending" });

    const outcome = await vault.consume(indexer.indexer);
    expect(outcome.outbox).toMatchObject({ attempted: 1, published: 1, failed: 0 });
    // MCP indexing is immediate: the intent is already due.
    expect(outcome.index).toMatchObject({ due: 1, applied: 1 });
    expect(gateway.changes).toEqual([[{ op: "put", path: "bus/mcp-note.md", etag: written.etag, size: written.size }]]);
    expect(indexer.calls).toEqual([{ path: "bus/mcp-note.md", action: "upsert" }]);
    expect(store.snapshotIntents()).toEqual([]);
    await expect(journal.findByMutationId(written.mutationId)).resolves.toMatchObject({ broadcastState: "published", gatewayGeneration: "1" });
  });

  it("journals a delete and broadcasts it as a delete", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const gateway = countingGateway();
    const indexer = recordingIndexer();
    const vault = vaultFor(journal, gateway.publisher);
    await bindings().MINERAL.put("bus/mcp-delete.md", encoder.encode("gone soon"));

    const deleted = await vault.service.documents.delete("bus/mcp-delete.md", { source: "mcp" });
    expect(deleted).toMatchObject({ key: "bus/mcp-delete.md", mutationPending: false });
    expect(await bindings().MINERAL.head("bus/mcp-delete.md")).toBeNull();

    const outcome = await vault.consume(indexer.indexer);
    expect(outcome.outbox.published).toBe(1);
    expect(outcome.index).toMatchObject({ due: 1, applied: 1 });
    expect(gateway.changes).toEqual([[{ op: "delete", path: "bus/mcp-delete.md" }]]);
    expect(indexer.calls).toEqual([{ path: "bus/mcp-delete.md", action: "remove" }]);
  });
});

describe("Mutation bus: Obsidian ingress", () => {
  it("accepts a report of an R2 write, then broadcasts and indexes it exactly once", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const gateway = countingGateway();
    const indexer = recordingIndexer();
    const vault = vaultFor(journal, gateway.publisher);
    const ingress = createMutationIngress({ MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "t" }, journal, vault.service.mutations);

    // The plugin performs its own conditional R2 write, then reports it.
    const key = "bus/obsidian-note.md";
    const put = (await bindings().MINERAL.put(key, encoder.encode("# from obsidian\n")))!;
    const accepted = await ingress.record({ id: "mut_obsidian_report", source: "obsidian", op: "put", path: key, etag: put.etag, size: 17, committedAt: 1_000 });

    expect(accepted).toMatchObject({ status: "accepted", seq: 1 });
    expect(store.snapshotJournal()[0]).toMatchObject({ id: "mut_obsidian_report", source: "obsidian", op: "put", path: key });

    // A retry of the same report is idempotent and adds nothing.
    await expect(ingress.record({ id: "mut_obsidian_report", source: "obsidian", op: "put", path: key, etag: put.etag, size: 17, committedAt: 1_000 }))
      .resolves.toMatchObject({ status: "duplicate", seq: 1 });
    expect(store.snapshotJournal()).toHaveLength(1);

    const outcome = await vault.consume(indexer.indexer);
    expect(outcome.outbox).toMatchObject({ published: 1 });
    // The manual edit is debounced, so nothing is indexed inside the window...
    expect(outcome.index).toMatchObject({ due: 0, applied: 0 });
    expect(gateway.generations()).toBe(1);

    // ...and exactly one apply happens once the window closes.
    const later = await drainDueIndex({ journal, indexer: indexer.indexer, now: () => Date.now() + 60_000 });
    expect(later).toMatchObject({ applied: 1 });
    expect(indexer.calls).toEqual([{ path: key, action: "upsert" }]);
    expect(gateway.generations()).toBe(1);
  });

  it("does not turn another device's write into a new mutation", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const gateway = countingGateway();
    const indexer = recordingIndexer();
    const vault = vaultFor(journal, gateway.publisher);

    // Device A writes and reports.
    const key = "bus/echo.md";
    const remote = (await bindings().MINERAL.put(key, encoder.encode("from device A")))!;
    const ingress = createMutationIngress({ MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "t" }, journal, vault.service.mutations);
    await ingress.record({ id: "mut_device_a", source: "obsidian", op: "put", path: key, etag: remote.etag, size: 12, committedAt: 1_000 });

    // Device B downloads the bytes and applies them locally. That apply is not a fact, and the
    // ingress route must not be told otherwise — even if a client tries, its id would be new but
    // the ETag report would be a duplicate of state that is already journalled.
    const downloaded = await bindings().MINERAL.get(key);
    expect(decoder.decode(await downloaded!.arrayBuffer())).toBe("from device A");

    await vault.consume(indexer.indexer);
    // Exactly one journal fact and exactly one generation for device A's write.
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(gateway.generations()).toBe(1);
    expect(indexer.calls).toHaveLength(0);
  });

  it("rejects a report whose revision R2 does not hold, and records nothing", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const gateway = countingGateway();
    const vault = vaultFor(journal, gateway.publisher);
    const ingress = createMutationIngress({ MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "t" }, journal, vault.service.mutations);

    await bindings().MINERAL.put("bus/forged.md", encoder.encode("real bytes"));
    await expect(ingress.record({ id: "mut_forged", source: "obsidian", op: "put", path: "bus/forged.md", etag: "i-made-this-up", size: 999, committedAt: 1_000 }))
      .rejects.toMatchObject({ reason: "state-mismatch" });

    expect(store.snapshotJournal()).toHaveLength(0);
    expect(store.snapshotIntents()).toHaveLength(0);
    expect(gateway.generations()).toBe(0);
  });
});
