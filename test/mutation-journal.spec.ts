import { describe, expect, it } from "vitest";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore } from "../apps/vault/src/mutation/store";
import { createMutationRecorder } from "../apps/vault/src/mutation/recorder";
import { indexIntentsFor, OBSIDIAN_INDEX_DEBOUNCE_MS } from "../apps/vault/src/index/intents";
import { vaultIndex as vaultIndexStub } from "./support";

/** A deterministic clock and id source, so a test can assert exact facts. */
function harness() {
  const store = new MemoryMutationStore();
  const journal = journalFromStore(store);
  let id = 0;
  let clock = 1_700_000_000_000;
  const recorder = createMutationRecorder({
    journal,
    nextId: () => `mut_test_${++id}`,
    now: () => (clock += 1_000),
  });
  return { store, journal, recorder, at: (offset: number) => clock + offset };
}

describe("recordMutation()", () => {
  it("journals an MCP put with its revision and an immediate index intent", async () => {
    const { store, recorder } = harness();
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "notes/a.md", etag: "etag-a", size: 12 });

    expect(recorded).toMatchObject({ inserted: true, duplicate: false, seq: 1 });
    const [entry] = store.snapshotJournal();
    expect(entry).toMatchObject({ id: recorded.id, seq: 1, source: "mcp", op: "put", path: "notes/a.md", etag: "etag-a", size: 12, broadcastState: "pending" });
    const [intent] = store.snapshotIntents();
    expect(intent).toMatchObject({ path: "notes/a.md", action: "upsert", targetEtag: "etag-a", source: "mcp" });
    // MCP has a completion boundary, so it is indexed immediately rather than debounced.
    expect(intent.notBefore).toBe(entry.committedAt);
  });

  it("journals an MCP delete as an immediate remove", async () => {
    const { store, recorder } = harness();
    await recorder.record({ source: "mcp", op: "delete", path: "notes/gone.md" });
    expect(store.snapshotJournal()[0]).toMatchObject({ op: "delete", path: "notes/gone.md", source: "mcp" });
    expect(store.snapshotIntents()[0]).toMatchObject({ action: "remove", targetEtag: null });
  });

  it("journals an Obsidian put with its debounce window", async () => {
    const { store, recorder } = harness();
    await recorder.record({ source: "obsidian", op: "put", path: "daily/2026-09-23.md", etag: "etag-o", size: 20 });
    const [entry] = store.snapshotJournal();
    const [intent] = store.snapshotIntents();
    expect(entry).toMatchObject({ source: "obsidian", op: "put" });
    expect(intent.notBefore).toBe(entry.committedAt + OBSIDIAN_INDEX_DEBOUNCE_MS);
  });

  it("journals an Obsidian delete as an immediate remove", async () => {
    const { store, recorder } = harness();
    const recorded = await recorder.record({ source: "obsidian", op: "delete", path: "daily/old.md" });
    const [entry] = store.snapshotJournal();
    const [intent] = store.snapshotIntents();
    expect(entry).toMatchObject({ source: "obsidian", op: "delete", seq: recorded.seq });
    expect(intent).toMatchObject({ action: "remove" });
    expect(intent.notBefore).toBe(entry.committedAt);
  });

  it("ignores a duplicate mutation id instead of recording a second fact", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const recorder = createMutationRecorder({ journal, nextId: () => "mut_stable", now: () => 5_000 });
    const first = await recorder.record({ source: "obsidian", op: "put", path: "a.md", etag: "A", size: 1 });
    const second = await recorder.record({ source: "obsidian", op: "put", path: "a.md", etag: "A", size: 1 });

    expect(first).toMatchObject({ inserted: true, seq: 1 });
    expect(second).toMatchObject({ inserted: false, duplicate: true, seq: 1 });
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(store.snapshotIntents()).toHaveLength(1);
  });

  it("keeps seq monotonic and preserves the reported source", async () => {
    const { store, recorder } = harness();
    await recorder.record({ source: "obsidian", op: "put", path: "a.md", etag: "A", size: 1 });
    await recorder.record({ source: "mcp", op: "put", path: "b.md", etag: "B", size: 2 });
    await recorder.record({ source: "web", op: "delete", path: "c.md" });
    await recorder.record({ source: "system", op: "put", path: ".history/one/a.md", etag: "H", size: 1 });

    expect(store.snapshotJournal().map(entry => [entry.seq, entry.source])).toEqual([[1, "obsidian"], [2, "mcp"], [3, "web"], [4, "system"]]);
  });

  it("rejects an event that is not a bounded mutation fact", async () => {
    const { recorder } = harness();
    // @ts-expect-error a put without a revision is not a mutation
    await expect(recorder.record({ source: "mcp", op: "put", path: "a.md" })).rejects.toThrow(TypeError);
    // @ts-expect-error an unknown source is not a write origin
    await expect(recorder.record({ source: "rogue", op: "delete", path: "a.md" })).rejects.toThrow(TypeError);
  });
});

describe("index intent policy", () => {
  it("decomposes a rename into an immediate remove(old) + upsert(new)", () => {
    const intents = indexIntentsFor({ id: "m1", source: "obsidian", op: "rename", from: "old.md", path: "new.md", etag: "E", committedAt: 1_000 });
    expect(intents).toEqual([
      { path: "old.md", action: "remove", targetEtag: null, notBefore: 1_000 },
      { path: "new.md", action: "upsert", targetEtag: "E", notBefore: 1_000 },
    ]);
  });
});

/**
 * The durable half, exercised against the real `VaultIndex` Durable Object so the SQLite schema,
 * the unique-key guard, and the transaction are the ones that actually ship.
 */
type VaultIndexStub = {
  recordMutation(input: { event: unknown; intents: unknown[] }): Promise<{ inserted: boolean; seq: number; entry: { id: string; seq: number } }>;
  findMutation(id: string): Promise<{ id: string; seq: number } | null>;
  resetMutationState(): Promise<void>;
  pendingSummary(now: number): Promise<{ due: number; upserts: number; removes: number; earliestNotBefore: number | null }>;
  listPendingBroadcasts(limit: number): Promise<Array<{ id: string; seq: number; path: string }>>;
  markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): Promise<void>;
  listDueIndexPaths(now: number, limit: number): Promise<Array<{ path: string; action: string; targetEtag: string | null }>>;
  claimPendingIndex(input: { path: string; etag: string | null; action: string; now: number }): Promise<{ status: string; attempts?: number }>;
  completeIndex(input: { path: string; etag: string | null; action: string }): Promise<boolean>;
  failIndex(input: { path: string; etag: string | null; action: string; error: string; notBefore: number }): Promise<void>;
};

function vaultIndex(): VaultIndexStub {
  return vaultIndexStub() as unknown as VaultIndexStub;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5));

describe("Mutation Journal durability (VaultIndex)", () => {
  it("commits the fact and its intents together, and is idempotent by mutation_id", async () => {
    const index = vaultIndex();
    await index.resetMutationState();
    const event = { id: "mut_do_one", source: "mcp", op: "put", path: "durable/one.md", etag: "E1", size: 3, committedAt: 1_000 };
    const first = await index.recordMutation({ event, intents: indexIntentsFor(event as never) });
    const second = await index.recordMutation({ event, intents: indexIntentsFor(event as never) });

    expect(first).toMatchObject({ inserted: true, seq: 1 });
    expect(second).toMatchObject({ inserted: false, seq: 1 });
    await expect(index.findMutation("mut_do_one")).resolves.toMatchObject({ id: "mut_do_one", seq: 1 });
    const summary = await index.pendingSummary(1_000);
    expect(summary.due).toBe(1);
    expect(summary.upserts).toBe(1);
  });

  it("round-trips a pending broadcast and records the gateway generation once published", async () => {
    const index = vaultIndex();
    await index.resetMutationState();
    const event = { id: "mut_do_broadcast", source: "mcp", op: "put", path: "durable/broadcast.md", etag: "E1", size: 3, committedAt: 1_000 };
    await index.recordMutation({ event, intents: indexIntentsFor(event as never) });
    await expect(index.listPendingBroadcasts(10)).resolves.toHaveLength(1);

    await index.markBroadcast({ mutationId: "mut_do_broadcast", state: "pending", error: "transport" });
    const [stillPending] = await index.listPendingBroadcasts(10);
    expect(stillPending).toMatchObject({ id: "mut_do_broadcast" });

    await index.markBroadcast({ mutationId: "mut_do_broadcast", state: "published", generation: "42" });
    await expect(index.listPendingBroadcasts(10)).resolves.toHaveLength(0);
  });

  it("keeps a newer intent when a worker completes the revision it claimed", async () => {
    const index = vaultIndex();
    await index.resetMutationState();
    const eventA = { id: "mut_do_cas_a", source: "obsidian", op: "put", path: "durable/cas.md", etag: "A", size: 1, committedAt: 2_000 };
    await index.recordMutation({ event: eventA, intents: indexIntentsFor(eventA as never) });
    const [due] = await index.listDueIndexPaths(2_000 + OBSIDIAN_INDEX_DEBOUNCE_MS, 10);
    expect(due).toEqual({ path: "durable/cas.md", action: "upsert", targetEtag: "A" });
    await expect(index.claimPendingIndex({ path: "durable/cas.md", etag: "A", action: "upsert", now: 2_000 + OBSIDIAN_INDEX_DEBOUNCE_MS })).resolves.toMatchObject({ status: "claimed", attempts: 1 });

    // A newer revision lands while the worker is indexing A.
    await flush();
    const eventB = { id: "mut_do_cas_b", source: "obsidian", op: "put", path: "durable/cas.md", etag: "B", size: 2, committedAt: 3_000 };
    await index.recordMutation({ event: eventB, intents: indexIntentsFor(eventB as never) });

    await expect(index.completeIndex({ path: "durable/cas.md", etag: "A", action: "upsert" })).resolves.toBe(false);
    const stillDue = await index.listDueIndexPaths(3_000 + OBSIDIAN_INDEX_DEBOUNCE_MS, 10);
    expect(stillDue).toEqual([{ path: "durable/cas.md", action: "upsert", targetEtag: "B" }]);
  });

  it("does not let a claim or a completion cross an action change", async () => {
    const index = vaultIndex();
    await index.resetMutationState();
    const put = { id: "mut_do_flip_put", source: "mcp", op: "put", path: "durable/flip.md", etag: "P", size: 1, committedAt: 4_000 };
    await index.recordMutation({ event: put, intents: indexIntentsFor(put as never) });
    await expect(index.claimPendingIndex({ path: "durable/flip.md", etag: "P", action: "upsert", now: 4_000 })).resolves.toMatchObject({ status: "claimed" });

    const remove = { id: "mut_do_flip_delete", source: "mcp", op: "delete", path: "durable/flip.md", committedAt: 4_100 };
    await index.recordMutation({ event: remove, intents: indexIntentsFor(remove as never) });

    await expect(index.completeIndex({ path: "durable/flip.md", etag: "P", action: "upsert" })).resolves.toBe(false);
    await expect(index.completeIndex({ path: "durable/flip.md", etag: null, action: "remove" })).resolves.toBe(true);
    await expect(index.pendingSummary(9_999_999)).resolves.toMatchObject({ due: 0 });
  });
});
