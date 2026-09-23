import { describe, expect, it } from "vitest";
import { createVaultService } from "../apps/vault/src/service";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore, type MutationJournal, type MutationStore } from "../apps/vault/src/mutation/store";
import { createMutationRecorder } from "../apps/vault/src/mutation/recorder";
import { parseCommittedMutation, recordCommittedMutationUntilRecorded, REPAIR_ATTEMPTS } from "../apps/vault/src/mutation/committed";
import type { MutationEvent } from "../apps/vault/src/mutation/types";
import { bindings, failingJournal, vaultEntrypoint, vaultIndex } from "./support";

const encoder = new TextEncoder();

function harness(journal: MutationJournal = journalFromStore(new MemoryMutationStore())) {
  const recorder = createMutationRecorder({ journal, nextId: () => "mut_generated", now: () => 1_000 });
  return { journal, recorder };
}

/** A journal whose `recordMutation` fails the first `failures` times, like a transient storage blip. */
function flakyJournal(failures: number) {
  const store = new MemoryMutationStore();
  const base = journalFromStore(store);
  let remaining = failures;
  let attempts = 0;
  const journal: MutationJournal = {
    ...base,
    recordMutation: async input => {
      attempts++;
      if (remaining > 0) {
        remaining--;
        throw new Error("journal unavailable");
      }
      return base.recordMutation(input);
    },
  };
  return { store, journal, attempts: () => attempts };
}

const committed = (overrides: Partial<MutationEvent> = {}): MutationEvent => ({
  id: "mut_committed",
  source: "mcp",
  committedAt: 1_700_000_000_000,
  op: "put",
  path: "repair/note.md",
  etag: "E1",
  size: 5,
  ...overrides,
} as MutationEvent);

describe("committed mutation validation", () => {
  it("accepts the authoritative writers and rejects a client claiming to be Obsidian", () => {
    expect(parseCommittedMutation(committed())).toMatchObject({ id: "mut_committed", source: "mcp", op: "put" });
    // Only the Vault's own writers may assert that a write already happened.
    expect(parseCommittedMutation(committed({ source: "obsidian" }))).toBeNull();
    expect(parseCommittedMutation(committed({ id: "" }))).toBeNull();
    // A put without a revision, and a rename without its origin path, cannot describe a committed fact.
    expect(parseCommittedMutation({ id: "x", source: "mcp", op: "put", path: "a.md", committedAt: 1 })).toBeNull();
    expect(parseCommittedMutation({ id: "x", source: "mcp", op: "rename", path: "b.md", committedAt: 1 })).toBeNull();
    expect(parseCommittedMutation({ id: "x", source: "mcp", op: "delete", path: "a.md", committedAt: 1 })).toMatchObject({ op: "delete" });
    expect(parseCommittedMutation({ id: "x", source: "mcp", op: "delete", path: "a.md", etag: "E", committedAt: 1 })).toMatchObject({ op: "delete", etag: "E" });
  });
});

describe("recordCommittedMutationUntilRecorded", () => {
  it("retries with the same id until the fact lands", async () => {
    const flaky = flakyJournal(2);
    const { recorder } = harness(flaky.journal);
    const sleeps: number[] = [];

    const result = await recordCommittedMutationUntilRecorded({ journal: flaky.journal, recorder, sleep: async ms => { sleeps.push(ms); } }, committed());

    expect(result).toMatchObject({ recorded: true, seq: 1, attempts: 3 });
    expect(flaky.attempts()).toBe(3);
    expect(sleeps).toEqual([200, 400]);
    expect(flaky.store.snapshotJournal()).toHaveLength(1);
    expect(flaky.store.snapshotIntents()).toHaveLength(1);
  });

  it("is idempotent: a fact that already landed is never recorded twice", async () => {
    const store = new MemoryMutationStore();
    const journal = journalFromStore(store);
    const { recorder } = harness(journal);
    await journal.recordMutation({ event: committed(), intents: [] });

    await expect(recordCommittedMutationUntilRecorded({ journal, recorder, sleep: async () => {} }, committed()))
      .resolves.toMatchObject({ recorded: true, seq: 1, attempts: 0 });
    expect(store.snapshotJournal()).toHaveLength(1);
  });

  it("gives up after a bounded number of attempts instead of looping", async () => {
    const flaky = flakyJournal(Number.POSITIVE_INFINITY);
    const { recorder } = harness(flaky.journal);

    await expect(recordCommittedMutationUntilRecorded({ journal: flaky.journal, recorder, sleep: async () => {} }, committed())).rejects.toThrow("journal unavailable");
    expect(flaky.attempts()).toBe(REPAIR_ATTEMPTS);
  });
});

describe("VaultEntrypoint repair (the real RPC surface)", () => {
  const vault = () => vaultEntrypoint();

  it("returns the revision of a committed write and records it exactly once", async () => {
    const key = "repair/committed.md";
    const written = await vault().putDocument({ key, bytes: encoder.encode("hello"), contentType: "text/markdown" });

    expect(written).toMatchObject({ size: 5, mutationPending: false });
    expect(written.etag).toBeTruthy();
    expect(written.mutationId).toMatch(/^mut_/);

    // Waiting for the deferred repair/drain to settle, then retrying the record is a no-op.
    await new Promise(resolve => setTimeout(resolve, 50));
    const again = await vault().recordCommittedMutation!({
      id: written.mutationId,
      source: "mcp",
      op: "put",
      path: key,
      etag: written.etag,
      size: written.size,
      committedAt: 1_700_000_000_000,
    });
    expect(again).toMatchObject({ recorded: true, seq: written.mutationSeq, attempts: 0 });
  });

  it("records a committed mutation without touching R2", async () => {
    const key = "repair/never-written.md";
    expect(await bindings().MINERAL.head(key)).toBeNull();

    const recorded = await vault().recordCommittedMutation!({
      id: "mut_repair_only",
      source: "mcp",
      op: "put",
      path: key,
      etag: "E-not-in-r2",
      size: 3,
      committedAt: 1_700_000_000_000,
    });

    expect(recorded).toMatchObject({ recorded: true });
    // The repair records the fact; it must never create the object it describes.
    expect(await bindings().MINERAL.head(key)).toBeNull();
  });

  it("answers, rather than throws, when a caller claims a source it cannot have", async () => {
    // The write already succeeded; a bad record request must not look like a transport failure.
    await expect(vault().recordCommittedMutation!({ id: "mut_forged_repair", source: "obsidian" as never, op: "put", path: "a.md", etag: "E", size: 1, committedAt: 1 }))
      .resolves.toMatchObject({ recorded: false, attempts: 0 });
  });

  it("still reports a delete with the revision it removed, so a repair can describe it", async () => {
    const key = "repair/deleted.md";
    const put = await vault().putDocument({ key, bytes: encoder.encode("bye") });
    const deleted = await vault().deleteDocuments(key);

    expect(deleted.deleted).toEqual([key]);
    expect(deleted.etags).toEqual([put.etag]);
    expect(deleted.mutationPending).toBe(false);
    expect(await bindings().MINERAL.head(key)).toBeNull();
  });
});

/**
 * The invariant this whole round is about: a write that reached R2 but not the journal must reach it
 * on its own, because "wait for a human to run refresh()" is not a repair path.
 *
 * The failure is injected at the journal, so the write path under test is the shipped one — including
 * the `mutationPending` signal the caller receives and the fact that the write still succeeds.
 */
describe("R2 success + journal failure self-heals", () => {
  const stub = () => vaultIndex() as unknown as { resetMutationState(): Promise<void>; findMutation(id: string): Promise<unknown> };

  /** The shipped service, with only the journal's write failing. */
  function vaultWith(journal: MutationJournal) {
    const configured = bindings();
    return {
      service: createVaultService({ MINERAL: configured.MINERAL, VAULT_INDEX: configured.VAULT_INDEX }, { journal }),
      configured,
    };
  }

  it("tells the writer the bytes are durable while the journal is down", async () => {
    await stub().resetMutationState();
    const broken = failingJournal();
    const { service, configured } = vaultWith(broken.journal);
    const key = "repair/self-heal.md";

    const written = await service.documents.put({ key, bytes: encoder.encode("written once"), contentType: "text/markdown" }, { source: "mcp" });

    // The write succeeded and says so; the journal problem is reported, not hidden and not fatal.
    expect(written).toMatchObject({ mutationPending: true, size: 12 });
    expect(written.mutationId).toMatch(/^mut_/);
    expect(await configured.MINERAL.head(key)).not.toBeNull();
    // Nothing was journalled, so nothing can be broadcast or indexed yet.
    await expect(stub().findMutation(written.mutationId)).resolves.toBeNull();
  });

  it("lands the fact when the journal heals, through the record-only path", async () => {
    await stub().resetMutationState();
    const broken = failingJournal();
    const { service } = vaultWith(broken.journal);
    const key = "repair/self-heal-2.md";

    const written = await service.documents.put({ key, bytes: encoder.encode("written once"), contentType: "text/markdown" }, { source: "mcp" });
    expect(written.mutationPending).toBe(true);

    broken.heal();
    const repaired = await service.recordCommitted({
      id: written.mutationId,
      source: "mcp",
      op: "put",
      path: key,
      etag: written.etag,
      size: written.size,
      committedAt: 1_700_000_000_000,
    });

    expect(repaired).toMatchObject({ mutationId: written.mutationId, inserted: true });
    await expect(stub().findMutation(written.mutationId)).resolves.toMatchObject({ id: written.mutationId, op: "put", path: key });
    // Exactly one object, written exactly once: the repair never re-applies the write.
    const listed = await bindings().MINERAL.list({ prefix: key });
    expect(listed.objects).toHaveLength(1);

    // A second hand-back is a no-op with the same sequence, never a second fact.
    await expect(service.recordCommitted({
      id: written.mutationId, source: "mcp", op: "put", path: key, etag: written.etag, size: written.size, committedAt: 1_700_000_000_000,
    })).resolves.toMatchObject({ inserted: false, mutationId: written.mutationId });
  });

  it("does the same for a delete, whose removed revision is known before the object goes away", async () => {
    await stub().resetMutationState();
    const broken = failingJournal();
    const { service, configured } = vaultWith(broken.journal);
    const key = "repair/self-heal-delete.md";
    const seeded = (await configured.MINERAL.put(key, encoder.encode("to be removed")))!;

    const deleted = await service.documents.delete(key, { source: "mcp" });
    expect(deleted).toMatchObject({ mutationPending: true, key });

    broken.heal();
    const entry = await service.recordCommitted({ id: deleted.mutationId, source: "mcp", op: "delete", path: key, committedAt: 1_700_000_000_000 });
    expect(entry.inserted).toBe(true);
    await expect(stub().findMutation(deleted.mutationId)).resolves.toMatchObject({ op: "delete", path: key });
    // The revision the report describes is the one that was there; R2 never needs another write.
    expect(seeded.etag).toBeTruthy();
    expect(await configured.MINERAL.head(key)).toBeNull();
  });

  it("keeps the recorded revision of a delete available to the caller", async () => {
    const key = "repair/delete-etag.md";
    const { service: healthy } = vaultWith(journalFromStore(new MemoryMutationStore()));
    const put = await healthy.documents.put({ key, bytes: encoder.encode("bye") }, { source: "mcp" });
    const deleted = await healthy.documents.delete(key, { source: "mcp" });
    expect(put.etag).toBeTruthy();
    expect(deleted.etag).toBeTruthy();
  });
});

describe("the journal contract the repair relies on", () => {
  it("keeps one fact per mutation id even when the same write is recorded repeatedly", () => {
    const store: MutationStore = new MemoryMutationStore();
    const event = committed();
    const first = store.record(event, []);
    const second = store.record(event, []);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.seq).toBe(first.seq);
    expect(store.findByMutationId(event.id)?.seq).toBe(first.seq);
  });
});
