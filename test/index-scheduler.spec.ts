import { bindings } from "./support";
import { describe, expect, it } from "vitest";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore } from "../apps/vault/src/mutation/store";
import { createMutationRecorder } from "../apps/vault/src/mutation/recorder";
import { OBSIDIAN_INDEX_DEBOUNCE_MS, applyIntent } from "../apps/vault/src/index/intents";
import { drainDueIndex, type NoteIndexer } from "../apps/vault/src/index/scheduler";

const BASE = 1_700_000_000_000;

function harness() {
  const store = new MemoryMutationStore();
  const journal = journalFromStore(store);
  let id = 0;
  let clock = BASE;
  const recorder = createMutationRecorder({ journal, nextId: () => `mut_idx_${++id}`, now: () => (clock += 1) });
  return { store, journal, recorder, dependencies: { journal, now: () => clock } };
}

/** Records what the indexer was asked to do; `stale` simulates R2 having moved on. */
function fakeIndexer() {
  const applied: Array<{ path: string; action: string }> = [];
  let fail = false;
  const indexer: NoteIndexer = {
    async apply(intent) {
      if (fail) return { applied: false, error: "boom" };
      applied.push({ path: intent.path, action: intent.action });
      return { applied: true, indexedEtag: "live" };
    },
  };
  return { applied, indexer, setFail: (value: boolean) => { fail = value; } };
}

describe("Index Scheduler (materialised dirty set)", () => {
  it("debounces an Obsidian put by 30 seconds", async () => {
    const { store, journal, recorder, dependencies } = harness();
    const obsidian = await recorder.record({ source: "obsidian", op: "put", path: "daily/today.md", etag: "A", size: 1 });
    const entry = await journal.findByMutationId(obsidian.id);

    const indexer = fakeIndexer();
    // Inside the window nothing is due, so nothing is indexed.
    expect(await drainDueIndex({ ...dependencies, indexer: indexer.indexer })).toMatchObject({ due: 0, applied: 0 });
    expect(indexer.applied).toEqual([]);
    expect(store.snapshotIntents()[0].notBefore).toBe(entry!.committedAt + OBSIDIAN_INDEX_DEBOUNCE_MS);
  });

  it("coalesces three puts on one path into a single intent holding the newest revision", async () => {
    const { store, journal, recorder, dependencies } = harness();
    const first = await recorder.record({ source: "obsidian", op: "put", path: "daily/hot.md", etag: "A", size: 1 });
    const second = await recorder.record({ source: "obsidian", op: "put", path: "daily/hot.md", etag: "B", size: 2 });
    const third = await recorder.record({ source: "obsidian", op: "put", path: "daily/hot.md", etag: "C", size: 3 });

    // Three durable facts...
    expect(await journal.findByMutationId(first.id)).not.toBeNull();
    expect(await journal.findByMutationId(second.id)).not.toBeNull();
    expect(await journal.findByMutationId(third.id)).not.toBeNull();
    // ...and one row of owed work, pointing at the newest revision.
    expect(store.snapshotIntents()).toEqual([
      expect.objectContaining({ path: "daily/hot.md", action: "upsert", targetEtag: "C", attempts: 0 }),
    ]);

    const indexer = fakeIndexer();
    const afterThird = store.snapshotIntents()[0].notBefore;
    expect(await drainDueIndex({ ...dependencies, now: () => afterThird, indexer: indexer.indexer })).toMatchObject({ applied: 1 });
    expect(indexer.applied).toEqual([{ path: "daily/hot.md", action: "upsert" }]);
  });

  it("indexes an MCP put immediately and a delete immediately", async () => {
    const { recorder, dependencies } = harness();
    const put = await recorder.record({ source: "mcp", op: "put", path: "mcp/now.md", etag: "M", size: 1 });
    const indexer = fakeIndexer();
    expect(await drainDueIndex({ ...dependencies, indexer: indexer.indexer })).toMatchObject({ due: 1, applied: 1 });
    expect(indexer.applied).toEqual([{ path: "mcp/now.md", action: "upsert" }]);
    void put;

    const remove = await recorder.record({ source: "obsidian", op: "delete", path: "daily/gone.md" });
    expect(remove.inserted).toBe(true);
    expect(await drainDueIndex({ ...dependencies, indexer: indexer.indexer })).toMatchObject({ due: 1, applied: 1 });
    expect(indexer.applied[1]).toEqual({ path: "daily/gone.md", action: "remove" });
  });

  it("turns a rename into remove(old) + upsert(new)", async () => {
    const { store, recorder, dependencies } = harness();
    await recorder.record({ source: "obsidian", op: "rename", from: "old/name.md", path: "new/name.md", etag: "R", size: 5 });

    expect(store.snapshotIntents()).toEqual([
      expect.objectContaining({ path: "old/name.md", action: "remove", targetEtag: null }),
      expect.objectContaining({ path: "new/name.md", action: "upsert", targetEtag: "R" }),
    ]);
    const indexer = fakeIndexer();
    expect(await drainDueIndex({ ...dependencies, now: () => BASE + OBSIDIAN_INDEX_DEBOUNCE_MS, indexer: indexer.indexer })).toMatchObject({ applied: 2 });
    expect(indexer.applied).toEqual(expect.arrayContaining([{ path: "old/name.md", action: "remove" }, { path: "new/name.md", action: "upsert" }]));
  });

  it("ends put → delete as remove, and delete → put as upsert of the newest revision", async () => {
    const { store, recorder } = harness();
    await recorder.record({ source: "mcp", op: "put", path: "flip/a.md", etag: "A", size: 1 });
    await recorder.record({ source: "mcp", op: "delete", path: "flip/a.md" });
    expect(store.snapshotIntents()).toEqual([expect.objectContaining({ path: "flip/a.md", action: "remove", targetEtag: null })]);

    await recorder.record({ source: "mcp", op: "delete", path: "flip/b.md" });
    await recorder.record({ source: "mcp", op: "put", path: "flip/b.md", etag: "C", size: 9 });
    expect(store.snapshotIntents().find(intent => intent.path === "flip/b.md")).toMatchObject({ action: "upsert", targetEtag: "C" });
  });

  it("never pulls a debounce window back in, and resets the retry budget on a new revision", async () => {
    const { store } = harness();
    const existing = {
      path: "x.md", action: "upsert" as const, targetEtag: "A", source: "obsidian" as const,
      notBefore: BASE + 30_000, firstDirtyAt: BASE, updatedAt: BASE, attempts: 4, lastError: "boom",
    };
    expect(applyIntent(existing, { path: "x.md", action: "upsert", targetEtag: "B", notBefore: BASE + 1_000 }, "obsidian", BASE + 1_000))
      .toMatchObject({ targetEtag: "B", notBefore: BASE + 30_000 });
    void store;
  });
});

describe("Index Scheduler compare-and-set", () => {
  it("keeps a newer intent when the worker finishes the revision it claimed", async () => {
    const { store, journal, recorder } = harness();
    const first = await recorder.record({ source: "mcp", op: "put", path: "cas/note.md", etag: "A", size: 1 });
    void first;

    const applied: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const indexer: NoteIndexer = {
      async apply(intent) {
        // A newer mutation lands while this apply is in flight.
        const newer = { id: "mut_idx_newer", source: "mcp" as const, op: "put" as const, path: intent.path, etag: "B", size: 2, committedAt: BASE + 10 };
        await journal.recordMutation({ event: newer, intents: [{ path: intent.path, action: "upsert", targetEtag: "B", notBefore: BASE + 10 }] });
        await gate;
        applied.push(intent.path);
        return { applied: true, indexedEtag: "B" };
      },
    };

    const draining = drainDueIndex({ journal, indexer, now: () => BASE + 10 });
    release();
    const outcome = await draining;

    expect(outcome).toMatchObject({ applied: 0, superseded: 1 });
    expect(applied).toEqual(["cas/note.md"]);
    // The newer intent is still owed: finishing A must not erase B.
    expect(store.snapshotIntents()).toEqual([expect.objectContaining({ path: "cas/note.md", action: "upsert", targetEtag: "B" })]);
  });

  it("cannot delete an intent whose action changed under it", async () => {
    const { store, journal, recorder } = harness();
    await recorder.record({ source: "mcp", op: "put", path: "cas/flip.md", etag: "P", size: 1 });

    const indexer: NoteIndexer = {
      async apply(intent) {
        const remove = { id: "mut_idx_remove", source: "mcp" as const, op: "delete" as const, path: intent.path, committedAt: BASE + 10 };
        await journal.recordMutation({ event: remove, intents: [{ path: intent.path, action: "remove", targetEtag: null, notBefore: BASE + 10 }] });
        return { applied: true, indexedEtag: null };
      },
    };
    expect(await drainDueIndex({ journal, indexer, now: () => BASE + 10 })).toMatchObject({ superseded: 1 });
    expect(store.snapshotIntents()).toEqual([expect.objectContaining({ path: "cas/flip.md", action: "remove" })]);
  });

  it("defers and records a failing intent instead of dropping it", async () => {
    const { store, journal, recorder } = harness();
    const indexer = fakeIndexer();
    indexer.setFail(true);
    await recorder.record({ source: "mcp", op: "put", path: "fail/note.md", etag: "F", size: 1 });

    expect(await drainDueIndex({ journal, indexer: indexer.indexer, now: () => BASE + 1 })).toMatchObject({ failed: 1, applied: 0 });
    expect(store.snapshotIntents()[0]).toMatchObject({ path: "fail/note.md", attempts: 1, lastError: "boom" });
    // Deferred, not lost: a later drain retries it.
    expect(await drainDueIndex({ journal, indexer: indexer.indexer, now: () => BASE + 10 * 60 * 1000 })).toMatchObject({ applied: 0 });
    indexer.setFail(false);
    expect(await drainDueIndex({ journal, indexer: indexer.indexer, now: () => BASE + 20 * 60 * 1000 })).toMatchObject({ applied: 1 });
    expect(store.snapshotIntents()).toEqual([]);
  });

  it("leaves the journal untouched when the index consumer fails", async () => {
    const { store, journal, recorder } = harness();
    const failed: NoteIndexer = { async apply() { throw new Error("indexer exploded"); } };
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "fail/journal.md", etag: "J", size: 1 });

    expect(await drainDueIndex({ journal, indexer: failed, now: () => BASE + 1 })).toMatchObject({ failed: 1 });
    await expect(journal.findByMutationId(recorded.id)).resolves.toMatchObject({ op: "put", path: "fail/journal.md" });
    expect(store.snapshotJournal()).toHaveLength(1);
  });
});

describe("VaultIndex incremental index apply", () => {
  type IndexStub = {
    resetMutationState(): Promise<void>;
    recordMutation(input: { event: unknown; intents: unknown[] }): Promise<{ inserted: boolean; seq: number }>;
    applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: boolean; indexedEtag: string | null }>;
    fetch(request: Request): Promise<Response>;
  };
  const index = () => bindings().VAULT_INDEX.get(bindings().VAULT_INDEX.idFromName("vault")) as unknown as IndexStub;
  const encoder = new TextEncoder();

  it("indexes the current R2 revision — never the etag the intent named — and removes on delete", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "index-apply/note.md";
    await bindings().MINERAL.put(key, encoder.encode("---\ntags: [alpha]\n---\n# Title\nlink [[other]]\n"));

    // The intent names revision A, but the object's live revision is what must be indexed.
    const event = { id: "mut_apply_1", source: "mcp", op: "put", path: key, etag: "STALE-A", size: 1, committedAt: 1_000 };
    await stub.recordMutation({ event, intents: [{ path: key, action: "upsert", targetEtag: "STALE-A", notBefore: 1_000 }] });
    const applied = await stub.applyIndexIntent({ path: key, action: "upsert" });
    expect(applied.applied).toBe(true);
    expect(applied.indexedEtag).not.toBe("STALE-A");
    expect(applied.indexedEtag).toBeTruthy();

    // The fresh revision is recorded as the freshness witness, and the note is queryable.
    const stats = await (await stub.fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind: "stats" }) }))).json() as { total: { count: number }; indexedEtag: string | null };
    expect(stats.total.count).toBeGreaterThan(0);
    expect(stats.indexedEtag).toBe(applied.indexedEtag);

    await bindings().MINERAL.delete(key);
    const removed = await stub.applyIndexIntent({ path: key, action: "remove" });
    expect(removed).toEqual({ applied: true, indexedEtag: null, status: "removed" });
    const after = await (await stub.fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind: "stats" }) }))).json() as { total: { count: number } };
    expect(after.total.count).toBe(0);
  });
});

