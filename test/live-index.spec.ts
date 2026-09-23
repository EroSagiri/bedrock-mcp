import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";

/**
 * The live index: one document, one revision, published atomically.
 *
 * These drive the real Durable Object, so they exercise the storage engine, the full-text table and the
 * enqueue rules the deployment actually uses.
 */
type IndexStub = {
  resetMutationState(): Promise<void>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: boolean; indexedEtag?: string | null; status?: string; error?: string }>;
  startIndexAudit(now: number): Promise<{ auditId: number; status: string }>;
  runIndexAuditPage(): Promise<{ audit: { auditId: number; scanned: number; dirty: number; status: string }; enqueued: string[]; removed: string[]; done: boolean } | null>;
  pendingSummary(now: number): Promise<{ due: number; upserts: number; removes: number; earliestNotBefore: number | null }>;
  indexedState(key: string): Promise<{ indexedEtag: string | null; indexVersion: number; indexedAt: string | null } | undefined>;
  fetch(request: Request): Promise<Response>;
};

const index = () => vaultIndex() as unknown as IndexStub;
const encoder = new TextEncoder();
const query = async (kind: string, input: Record<string, unknown> = {}) =>
  (await (await index().fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind, ...input }) }))).json()) as Record<string, unknown>;

describe("a document is searchable the moment it is indexed", () => {
  it("answers full text from the index, with the body it stored", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "live/fulltext.md";
    const body = "---\ntags: [mineral]\n---\n# Quartz ingestion\n\nThe mineral pipeline writes quartz bundles every night.\n";
    await bindings().MINERAL.put(key, encoder.encode(body));

    const applied = await stub.applyIndexIntent({ path: key, action: "upsert" });
    expect(applied).toMatchObject({ applied: true, status: "indexed" });

    const found = await query("search", { query: "quartz" });
    expect(found).toMatchObject({ source: "index", partial: false, staleDocuments: 0 });
    const results = found.results as Array<{ key: string; title: string | null; snippet: string }>;
    expect(results.map(result => result.key)).toEqual([key]);
    // The snippet comes from the index: no R2 read was involved in producing it.
    expect(results[0]!.snippet).toContain("quartz");
    expect(JSON.stringify(found)).toContain("quartz");
  });

  it("derives tags, links, headings and frontmatter in the same commit", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "live/derived.md";
    await bindings().MINERAL.put(key, encoder.encode("---\ntitle: Derived\ntags: [alpha, beta]\n---\n# First\n## Second\n\n#alpha #alpha\n\n[[other-note]]\n"));

    await stub.applyIndexIntent({ path: key, action: "upsert" });

    const tags = await query("tags", {});
    expect((tags.tags as Array<{ tag: string; referenceCount: number }>).map(tag => tag.tag).sort()).toEqual(["alpha", "beta"]);
    // `alpha` appears twice in the body and once in frontmatter; the counts stay separate by source.
    expect((tags.tags as Array<{ tag: string; frontmatterReferences: number; bodyReferences: number }>).find(tag => tag.tag === "alpha")).toMatchObject({ frontmatterReferences: 1, bodyReferences: 2 });
    expect((await query("outgoing", { key })).links).toEqual([{ link: "other-note" }]);
    expect((await query("headings", { key })).headings).toEqual([{ level: 1, text: "First", line: 1 }, { level: 2, text: "Second", line: 2 }]);
    expect((await query("frontmatter", { field: "title" })).matches).toEqual([{ key, modified: expect.any(String), value: "Derived" }]);
    // The title feeds the full-text column, so a heading search finds the note.
    expect(((await query("search", { query: "Derived" })).results as unknown[]).length).toBe(1);
  });

  it("is idempotent, and re-indexes when R2 moved", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "live/rev.md";
    const env = bindings();
    const first = (await env.MINERAL.put(key, encoder.encode("# one\n")))!;
    await stub.applyIndexIntent({ path: key, action: "upsert" });
    await expect(stub.indexedState(key)).resolves.toMatchObject({ indexedEtag: first.etag, indexVersion: 1 });

    // Same revision again: nothing to do, and nothing rewritten.
    expect(await stub.applyIndexIntent({ path: key, action: "upsert" })).toMatchObject({ status: "noop" });

    const second = (await env.MINERAL.put(key, encoder.encode("# two\n")))!;
    expect(second.etag).not.toBe(first.etag);
    expect(await stub.applyIndexIntent({ path: key, action: "upsert" })).toMatchObject({ status: "indexed" });
    const found = await query("search", { query: "two" });
    expect((found.results as Array<{ key: string }>).map(result => result.key)).toEqual([key]);
  });
});

describe("a remove intent re-observes R2 before deleting", () => {
  it("deletes only when the object is really gone", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "live/gone.md";
    const env = bindings();
    await env.MINERAL.put(key, encoder.encode("# ephemeral\n"));
    await stub.applyIndexIntent({ path: key, action: "upsert" });

    await env.MINERAL.delete(key);
    expect(await stub.applyIndexIntent({ path: key, action: "remove" })).toMatchObject({ applied: true, status: "removed" });
    await expect(stub.indexedState(key)).resolves.toBeUndefined();
  });

  it("turns a remove into an upsert when the object is still there", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "live/still-there.md";
    const env = bindings();
    await env.MINERAL.put(key, encoder.encode("# still here\n"));
    await stub.applyIndexIntent({ path: key, action: "upsert" });

    // This is the audit's false-delete path, and the reason an audit may only ever enqueue a hint:
    // the intent says remove, R2 says the object exists, so the index keeps it.
    const result = await stub.applyIndexIntent({ path: key, action: "remove" });
    expect(result).toMatchObject({ applied: true, status: "noop" });
    await expect(stub.indexedState(key)).resolves.toBeDefined();
    expect((((await query("search", { query: "still" })).results) as unknown[]).length).toBe(1);
  });
});

describe("the revision audit lists, diffs and enqueues", () => {
  it("enqueues what changed, and never deletes a document indexed during the walk", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    const key = "audit/existing.md";
    await env.MINERAL.put(key, encoder.encode("# existing\n"));
    await stub.applyIndexIntent({ path: key, action: "upsert" });
    expect((await stub.pendingSummary(Date.now())).upserts).toBe(0);

    // A document that exists in R2 but not in the index, created before the audit starts.
    const fresh = "audit/new.md";
    await env.MINERAL.put(fresh, encoder.encode("# new\n"));

    const started = await stub.startIndexAudit(Date.now() - 60_000);
    expect(started.status).toBe("running");

    const page = await stub.runIndexAuditPage();
    expect(page).not.toBeNull();
    expect(page!.enqueued).toContain(fresh);
    // The already-indexed document is not queued, and the walk is complete in one page.
    expect(page!.enqueued).not.toContain(key);
    expect(page!.done).toBe(true);
    expect((await stub.pendingSummary(Date.now())).upserts).toBeGreaterThanOrEqual(1);
  });

  it("reports the audit it is already running instead of starting a second", async () => {
    const stub = index();
    await stub.resetMutationState();
    const first = await stub.startIndexAudit(Date.now());
    const second = await stub.startIndexAudit(Date.now());
    expect(second.auditId).toBe(first.auditId);
  });
});

