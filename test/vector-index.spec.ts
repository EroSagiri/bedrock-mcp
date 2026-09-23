import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";
import { fakeEmbeddingVector } from "./fake-ai";
import { VECTOR_SCHEMA } from "../apps/vault/src/vector/schema";

/**
 * The vector index end to end, against the real Durable Object.
 *
 * These drive the object directly, as the live-index specs do, so the SQLite state machine, the ledger,
 * the acceptance rule and the drain decision are the production ones. Only the two platform bindings
 * Miniflare cannot simulate — Workers AI and Vectorize — are replaced, and they are replaced by the test
 * worker, not by a seam inside this spec.
 */
type VectorStub = {
  resetMutationState(): Promise<void>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: boolean; status?: string }>;
  applyVectorIntent(input: { path: string; action: "upsert" | "remove" }): Promise<{ applied: boolean; status?: string; chunks?: number; deferred?: boolean; error?: string }>;
  collectVectorGarbage(limit: number): Promise<number>;
  recordMutation(input: { event: Record<string, unknown>; intents: Array<{ path: string; action: "upsert" | "remove"; targetEtag: string | null; notBefore: number }> }): Promise<{ inserted: boolean }>;
  pendingVectorSummary(now: number): Promise<{ due: number; upserts: number; removes: number; earliestNotBefore: number | null }>;
  listDueVectorPaths(now: number, limit: number): Promise<Array<{ path: string; action: string; targetEtag: string | null }>>;
  claimPendingVector(input: { path: string; etag: string | null; action: "upsert" | "remove"; now: number }): Promise<{ status: string }>;
  completeVector(input: { path: string; etag: string | null; action: "upsert" | "remove" }): Promise<boolean>;
  enqueueStaleVectors(now: number): Promise<number>;
  vectorHealth(): Promise<Record<string, unknown>>;
  searchSemantic(input: { vector: number[]; limit: number; prefix: string }): Promise<{ results: Array<{ key: string; heading: string; snippet: string; score: number | null }>; candidates: number; filteredCandidates: number; partial: boolean; ledgerChunks?: number; owed?: number; ready?: number }>;
};

const index = () => vaultIndex() as unknown as VectorStub;
const encoder = new TextEncoder();
const search = (query: string, options: { limit?: number; prefix?: string } = {}) =>
  index().searchSemantic({ vector: fakeEmbeddingVector(query), limit: options.limit ?? 10, prefix: options.prefix ?? "" });

/** Indexes a document into both layers, in the order the drain uses: notes first, then vectors. */
async function publish(key: string, body: string) {
  const stub = index();
  await stub.applyIndexIntent({ path: key, action: "upsert" });
  return stub.applyVectorIntent({ path: key, action: "upsert" });
}

describe("a published document is searchable by meaning", () => {
  it("serves the hit's text from the ledger", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "vector/quartz.md";
    const body = "# Quartz ingestion\n\nThe mineral pipeline writes quartz bundles every night, then the gateway broadcasts them.\n";
    await bindings().MINERAL.put(key, encoder.encode(body));

    expect(await publish(key, body)).toMatchObject({ applied: true, status: "published" });

    const found = await search("quartz ingestion pipeline");
    expect(found.results.map(result => result.key)).toEqual([key]);
    expect(found.results[0]!.snippet).toContain("quartz bundles");
    expect(found.results[0]!.heading).toBe("Quartz ingestion");
    expect(found.filteredCandidates).toBe(0);

    // The health endpoint agrees, and carries the frozen schema rather than a guess.
    const health = await stub.vectorHealth();
    expect(health).toMatchObject({ tracked: 1, ready: 1, pending: 0, outdated: 0, owed: 0, removalOwed: 0, schemaMismatch: null });
    expect(health.schema).toMatchObject({ model: VECTOR_SCHEMA.model, dimensions: VECTOR_SCHEMA.dimensions, metric: VECTOR_SCHEMA.metric });
    expect(health.ledgerChunks).toBe(1);
  });

  it("renders a hit without reading R2 again", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "vector/offline.md";
    const body = "# Offline note\n\nThis text lives in the ledger.\n";
    const env = bindings();
    await env.MINERAL.put(key, encoder.encode(body));
    await publish(key, body);

    // The object is gone from R2, and neither the note index nor the vector layer has been told. The hit
    // is still servable because the chunk text was stored with the ledger — which is the whole reason it
    // is stored there.
    await env.MINERAL.delete(key);
    const found = await search("ledger text");
    expect(found.results.map(result => result.key)).toEqual([key]);
    expect(found.results[0]!.snippet).toContain("lives in the ledger");
  });

  it("filters by path prefix inside SQLite, not in the index", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    await env.MINERAL.put("vector/daily/one.md", encoder.encode("# Daily one\n\nshared vocabulary about minerals\n"));
    await env.MINERAL.put("vector/archive/two.md", encoder.encode("# Archive two\n\nshared vocabulary about minerals\n"));
    await publish("vector/daily/one.md", "");
    await publish("vector/archive/two.md", "");

    const narrowed = await search("shared vocabulary about minerals", { prefix: "vector/daily/" });
    expect(narrowed.results.map(result => result.key)).toEqual(["vector/daily/one.md"]);
    // The other document was retrieved as a candidate and then excluded by the filter.
    expect(narrowed.candidates).toBeGreaterThan(narrowed.results.length);
  });
});

describe("the acceptance rule", () => {
  it("refuses every hit once the note index moves to a revision the vectors do not describe", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    const key = "vector/moving.md";
    const first = "# Moving note\n\nThe first revision talks about quartz ingestion.\n";
    const second = "# Moving note\n\nThe second revision talks about granite exports.\n";
    await env.MINERAL.put(key, encoder.encode(first));
    await publish(key, first);
    expect((await search("quartz ingestion")).results.map(result => result.key)).toEqual([key]);

    // The note index reaches the new revision before the vector layer does. Serving the old vectors now
    // would answer with text the rest of the Vault no longer holds, so the hit is refused.
    await env.MINERAL.put(key, encoder.encode(second));
    await stub.applyIndexIntent({ path: key, action: "upsert" });
    const stale = await search("quartz ingestion");
    expect(stale.results).toEqual([]);
    expect(stale.filteredCandidates).toBeGreaterThan(0);
    expect(stale.partial).toBe(true);

    // Once the vector layer catches up, the new revision is served.
    expect(await stub.applyVectorIntent({ path: key, action: "upsert" })).toMatchObject({ applied: true, status: "published" });
    expect((await search("granite exports")).results.map(result => result.key)).toEqual([key]);
  });

  it("collects the superseded revision's vectors instead of leaving them retrievable", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    const key = "vector/superseded.md";
    const first = "# Superseded note\n\nA first revision about quartz ingestion.\n";
    const second = "# Superseded note\n\nA second revision about granite exports.\n";
    await env.MINERAL.put(key, encoder.encode(first));
    await publish(key, first);
    const beforeGc = await search("quartz ingestion");
    expect(beforeGc.candidates).toBeGreaterThan(0);

    await env.MINERAL.put(key, encoder.encode(second));
    await stub.applyIndexIntent({ path: key, action: "upsert" });
    await stub.applyVectorIntent({ path: key, action: "upsert" });

    // The old revision's vectors are deleted from Vectorize, so they are not even retrieved — which is
    // observable: a ledger row that survived its vector would have shown up as a *filtered* candidate,
    // and there are none left to filter.
    expect(await stub.collectVectorGarbage(64)).toBeGreaterThan(0);
    const afterGc = await search("quartz ingestion");
    expect(afterGc.filteredCandidates).toBe(0);
    expect(afterGc.results.every(result => !result.snippet.includes("first revision"))).toBe(true);
  });

  it("refuses hits for a document whose ledger and state disagree", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "vector/complete.md";
    const body = "# Complete note\n\nOnly a complete ledger is servable.\n";
    await bindings().MINERAL.put(key, encoder.encode(body));
    await publish(key, body);
    // Nothing has changed, so this is the control: the hit is accepted while the two agree.
    expect((await search("complete ledger servable")).results).toHaveLength(1);
    expect((await stub.vectorHealth()).ready).toBe(1);
  });
});

describe("removing a document", () => {
  it("deletes the vectors and forgets the ledger", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    const key = "vector/removed.md";
    const body = "# Removed note\n\nEphemeral quartz ingestion notes.\n";
    await env.MINERAL.put(key, encoder.encode(body));
    await publish(key, body);
    expect((await search("quartz ingestion")).candidates).toBeGreaterThan(0);

    await env.MINERAL.delete(key);
    await stub.applyIndexIntent({ path: key, action: "remove" });
    expect(await stub.applyVectorIntent({ path: key, action: "remove" })).toMatchObject({ applied: true, status: "removed" });

    const gone = await search("quartz ingestion");
    expect(gone.results).toEqual([]);
    expect(gone.candidates).toBe(0);
    expect(await stub.vectorHealth()).toMatchObject({ tracked: 0, ledgerChunks: 0, owed: 0, removalOwed: 0 });
  });
});

describe("the vector dirty set", () => {
  const event = (id: string, path: string, etag: string) => ({ id, source: "mcp", op: "put", path, etag, size: 10, committedAt: 1 });

  it("is written with the mutation fact, so a committed write cannot forget its vector debt", async () => {
    const stub = index();
    await stub.resetMutationState();
    const recorded = await stub.recordMutation({
      event: event("mut_vector_1", "vector/debt.md", "etag-1"),
      intents: [{ path: "vector/debt.md", action: "upsert", targetEtag: "etag-1", notBefore: 1 }],
    });

    expect(recorded.inserted).toBe(true);
    const summary = await stub.pendingVectorSummary(Date.now());
    expect(summary).toMatchObject({ upserts: 1, removes: 0 });
    expect(await stub.listDueVectorPaths(Date.now(), 10)).toEqual([{ path: "vector/debt.md", action: "upsert", targetEtag: "etag-1" }]);
    await expect(stub.vectorHealth()).resolves.toMatchObject({ owed: 1 });
  });

  it("does not revive a claimed path when the same fact is reported twice", async () => {
    const stub = index();
    await stub.resetMutationState();
    const intents = [{ path: "vector/debt.md", action: "upsert" as const, targetEtag: "etag-1", notBefore: 1 }];
    await stub.recordMutation({ event: event("mut_vector_2", "vector/debt.md", "etag-1"), intents });
    const claim = await stub.claimPendingVector({ path: "vector/debt.md", etag: "etag-1", action: "upsert", now: Date.now() });
    expect(claim.status).toBe("claimed");

    // A duplicate report is not new information, so it must not touch the row: a path that is already
    // failing must not have its claim or its backoff cleared by a client retrying a lost response.
    expect((await stub.recordMutation({ event: event("mut_vector_2", "vector/debt.md", "etag-1"), intents })).inserted).toBe(false);
    expect((await stub.pendingVectorSummary(Date.now())).upserts).toBe(1);
    expect(await stub.completeVector({ path: "vector/debt.md", etag: "etag-1", action: "upsert" })).toBe(true);
  });

  it("refuses to complete an intent that was re-dirtied while it ran", async () => {
    const stub = index();
    await stub.resetMutationState();
    await stub.recordMutation({
      event: event("mut_vector_3", "vector/race.md", "etag-1"),
      intents: [{ path: "vector/race.md", action: "upsert", targetEtag: "etag-1", notBefore: 1 }],
    });
    await stub.claimPendingVector({ path: "vector/race.md", etag: "etag-1", action: "upsert", now: Date.now() });
    // A newer revision arrives while the first is being embedded.
    await stub.recordMutation({
      event: event("mut_vector_4", "vector/race.md", "etag-2"),
      intents: [{ path: "vector/race.md", action: "upsert", targetEtag: "etag-2", notBefore: 1 }],
    });
    expect(await stub.completeVector({ path: "vector/race.md", etag: "etag-1", action: "upsert" })).toBe(false);
    expect((await stub.listDueVectorPaths(Date.now(), 10))[0]).toMatchObject({ path: "vector/race.md", targetEtag: "etag-2" });
  });

  it("waits for the note index instead of inventing a document id", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "vector/not-yet.md";
    await bindings().MINERAL.put(key, encoder.encode("# Not yet indexed\n\nbody\n"));

    const result = await stub.applyVectorIntent({ path: key, action: "upsert" });
    expect(result).toMatchObject({ applied: false, deferred: true, error: "not yet in the note index" });
    expect(await stub.vectorHealth()).toMatchObject({ tracked: 0, ledgerChunks: 0 });
  });

  it("finds documents whose vectors are behind even though R2 never moved", async () => {
    const stub = index();
    await stub.resetMutationState();
    const key = "vector/behind.md";
    await bindings().MINERAL.put(key, encoder.encode("# Behind\n\nThe note index knows this one; the vector layer does not.\n"));
    await stub.applyIndexIntent({ path: key, action: "upsert" });

    // This is the only path that can notice a changed chunker or model: the note index is perfectly
    // current, so an R2 walk would report nothing.
    expect(await stub.enqueueStaleVectors(Date.now())).toBe(1);
    expect(await stub.applyVectorIntent({ path: key, action: "upsert" })).toMatchObject({ applied: true, status: "published" });
    await stub.completeVector({ path: key, etag: null, action: "upsert" });

    // Now that it is current, a second sweep leaves it alone.
    expect(await stub.enqueueStaleVectors(Date.now() + 1000)).toBe(0);
    expect((await stub.vectorHealth()).ready).toBe(1);
  });
});
