import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";

/**
 * The commit-marker invariant, proven by breaking the commit.
 *
 * `indexed_etag` and `index_version` may only become current in the transaction that wrote every
 * derived row. A failure anywhere in that write must therefore leave the document exactly as it was,
 * so a reader can never see "current revision" while the full text, tags or links are missing.
 *
 * The failure is injected with a real SQLite trigger, which means the rollback under test is the
 * engine's, not a mock's.
 */
type IndexStub = {
  resetMutationState(): Promise<void>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: boolean; status?: string; error?: string }>;
  indexedState(key: string): Promise<{ indexedEtag: string | null; indexVersion: number } | undefined>;
  probeSql(sql: string): Promise<{ ok: boolean; error?: string }>;
  fetch(request: Request): Promise<Response>;
};

const index = () => vaultIndex() as unknown as IndexStub;
const encoder = new TextEncoder();
const searchResults = async (term: string) => {
  const response = await index().fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind: "search", query: term }) }));
  return ((await response.json()) as { results: Array<{ key: string }> }).results;
};

describe("a partial index write publishes nothing", () => {
  it("rolls the whole document back when one derived table rejects the write", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    const key = "atomic/note.md";
    const first = (await env.MINERAL.put(key, encoder.encode("# first revision\n")))!;

    // A good revision, so there is a previous state to protect.
    expect(await stub.applyIndexIntent({ path: key, action: "upsert" })).toMatchObject({ applied: true, status: "indexed" });
    await expect(stub.indexedState(key)).resolves.toMatchObject({ indexedEtag: first.etag, indexVersion: 1 });

    // Now break one of the derived writes. The trigger fires mid-transaction, after `documents` has
    // already been updated in that same transaction.
    expect(await stub.probeSql("CREATE TRIGGER fail_tags BEFORE INSERT ON document_tags BEGIN SELECT RAISE(ABORT, 'injected failure'); END")).toMatchObject({ ok: true });

    const second = (await env.MINERAL.put(key, encoder.encode("# second revision with uniqueword\n\n#atag\n")))!;
    const failed = await stub.applyIndexIntent({ path: key, action: "upsert" });

    expect(failed.applied).toBe(false);
    expect(failed.error).toContain("injected failure");
    // The commit marker never moved: the index still describes the first revision, completely.
    await expect(stub.indexedState(key)).resolves.toMatchObject({ indexedEtag: first.etag, indexVersion: 1 });
    expect(await searchResults("uniqueword")).toEqual([]);
    expect((await searchResults("first")).map(result => result.key)).toEqual([key]);

    // With the fault removed the same intent succeeds, so the failure deferred work rather than lost it.
    expect(await stub.probeSql("DROP TRIGGER fail_tags")).toMatchObject({ ok: true });
    expect(await stub.applyIndexIntent({ path: key, action: "upsert" })).toMatchObject({ applied: true, status: "indexed" });
    await expect(stub.indexedState(key)).resolves.toMatchObject({ indexedEtag: second.etag, indexVersion: 1 });
    expect((await searchResults("uniqueword")).map(result => result.key)).toEqual([key]);
  });
});



