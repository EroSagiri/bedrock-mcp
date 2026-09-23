import { describe, expect, it } from "vitest";
import { applyVectorIntent, collectVectorGarbage, type VectorPublishDeps, type VectorRecord, type VectorStatePort } from "../apps/vault/src/vector/publish";
import { VECTOR_SCHEMA, revisionFor, type VectorRevision } from "../apps/vault/src/vector/schema";
import type { VectorChunkRow, VectorDocumentState } from "../apps/vault/src/vector/store";

/**
 * A recording double for the ledger.
 *
 * It holds no logic on purpose: the SQL and the acceptance rule are exercised through the Durable Object,
 * where the real engine is. What this one exists to make visible is the **order** of a publish — that
 * Vectorize is written before SQLite is told the revision is servable, and that a cleanup deletes the
 * vector before it forgets the row that can still find it.
 */
function recordingState(events: string[], options: { existing?: VectorDocumentState; chunkIds?: string[]; stale?: Array<{ chunkId: string; documentId: number }> } = {}) {
  const state: VectorStatePort = {
    stateForDocument: () => options.existing,
    stateForKey: () => options.existing,
    beginAttempt: (documentId, key, desired, chunkCount) => events.push(`begin:${key}:${desired.contentSha256}:${chunkCount}`),
    recordNoop: (documentId, desired) => events.push(`noop:${desired.contentSha256}`),
    publishRevision: (documentId, key, revision, chunks) => events.push(`publish:${key}:${revision.contentSha256}:${chunks.length}`),
    chunkIdsOfDocument: () => options.chunkIds ?? [],
    staleLedger: () => options.stale ?? [],
    forgetChunks: ids => events.push(`forget-chunks:${ids.join(",")}`),
    forgetDocument: documentId => events.push(`forget-document:${documentId}`),
  };
  return state;
}

function deps(events: string[], overrides: Partial<VectorPublishDeps> = {}): VectorPublishDeps {
  const state = overrides.state ?? recordingState(events);
  return {
    state,
    readObject: async () => ({ text: "# Note\n\nbody text", etag: "etag-1" }),
    observeEtag: async () => "etag-1",
    lookupDocument: () => ({ id: 7 }),
    digest: async () => "c".repeat(64),
    embed: async texts => {
      events.push(`embed:${texts.length}`);
      return texts.map(() => new Array<number>(VECTOR_SCHEMA.dimensions).fill(0.1));
    },
    upsert: async (records: VectorRecord[]) => { events.push(`upsert:${records.map(record => record.id).join(",")}`); },
    deleteVectors: async (ids: string[]) => { events.push(`delete-vectors:${ids.join(",")}`); },
    publish: (port, documentId, key, revision, chunks, now) => port.publishRevision(documentId, key, revision, chunks, now),
    forget: (port, documentId) => port.forgetDocument(documentId),
    forgetChunks: (port, ids) => port.forgetChunks(ids),
    now: () => 1000,
    ...overrides,
  };
}

/** The identity a chunk id is derived from, for asserting that Vectorize received exactly those ids. */
async function expectedIds(path: string, documentId: number, text: string): Promise<string[]> {
  const { parseDocument } = await import("../apps/vault/src/index/parse");
  const { assignChunkIds, chunkDocument } = await import("../apps/vault/src/vector/chunk");
  // The digest is stubbed in `deps`, so the ids have to be derived from the same stub.
  const chunks = await assignChunkIds(chunkDocument(parseDocument(path, text)), { documentId, contentSha256: "c".repeat(64) });
  return chunks.map(chunk => chunk.chunkId);
}

describe("publishing a document's vectors", () => {
  it("writes Vectorize before SQLite is allowed to serve the revision", async () => {
    const events: string[] = [];
    const text = "# Note\n\nbody text";
    const ids = await expectedIds("notes/a.md", 7, text);

    const result = await applyVectorIntent(deps(events), { path: "notes/a.md", action: "upsert" });

    expect(result).toMatchObject({ applied: true, status: "published", chunks: ids.length });
    // The order is the contract: chunk → record the attempt → embed → upsert → publish.
    expect(events[0]).toMatch(/^begin:notes\/a\.md:/);
    expect(events[1]).toBe(`embed:${ids.length}`);
    expect(events[2]).toBe(`upsert:${ids.join(",")}`);
    expect(events[3]).toMatch(/^publish:notes\/a\.md:/);
    expect(events).toHaveLength(4);
  });

  it("does not re-embed a re-write of identical bytes", async () => {
    const events: string[] = [];
    const revision = revisionFor("c".repeat(64));
    const state = recordingState(events, {
      existing: { documentId: 7, key: "notes/a.md", status: "ready", desired: revision, desiredChunkCount: 2, active: revision, activeChunkCount: 2, updatedAt: 1, attempts: 0, lastError: null },
    });

    const result = await applyVectorIntent(deps(events, { state }), { path: "notes/a.md", action: "upsert" });

    // The ids are a function of the content hash, so the same bytes can only produce the same vectors.
    expect(result).toMatchObject({ applied: true, status: "noop", chunks: 1 });
    expect(events).toEqual([`noop:${"c".repeat(64)}`]);
  });

  it("waits for the note index instead of inventing a document id", async () => {
    const events: string[] = [];
    const result = await applyVectorIntent(deps(events, { lookupDocument: () => undefined }), { path: "notes/new.md", action: "upsert" });

    expect(result).toMatchObject({ applied: false, deferred: true });
    // Nothing was embedded and nothing was written: the ledger's only link to a note was missing.
    expect(events).toEqual([]);
  });

  it("refuses to publish a revision that moved while it was being embedded", async () => {
    const events: string[] = [];
    const result = await applyVectorIntent(deps(events, { observeEtag: async () => "etag-2" }), { path: "notes/a.md", action: "upsert" });

    expect(result).toMatchObject({ applied: false, deferred: true, error: "revision moved while embedding" });
    // The vectors were computed and then withheld: publishing them would have overwritten a newer revision.
    expect(events.some(event => event.startsWith("upsert:"))).toBe(false);
    expect(events.some(event => event.startsWith("publish:"))).toBe(false);
  });

  it("refuses to line up vectors that do not match the chunks they came from", async () => {
    const events: string[] = [];
    const depsWithShortEmbedding = deps(events, { embed: async texts => texts.slice(0, 1).map(() => new Array<number>(VECTOR_SCHEMA.dimensions).fill(0.1)) });
    // A one-chunk document, so the mismatch has to be forced by returning nothing.
    await expect(applyVectorIntent({ ...depsWithShortEmbedding, embed: async () => [] }, { path: "notes/a.md", action: "upsert" })).rejects.toThrow(/count mismatch/);
    expect(events.some(event => event.startsWith("upsert:"))).toBe(false);
  });

  it("removes vectors before forgetting the rows that can still find them", async () => {
    const events: string[] = [];
    const state = recordingState(events, {
      existing: { documentId: 7, key: "notes/a.md", status: "ready", desired: null, desiredChunkCount: 2, active: null, activeChunkCount: 2, updatedAt: 1, attempts: 0, lastError: null },
      chunkIds: ["chunk-a", "chunk-b"],
    });

    const result = await applyVectorIntent(deps(events, { state, readObject: async () => null }), { path: "notes/a.md", action: "remove" });

    expect(result).toMatchObject({ applied: true, status: "removed", chunks: 2 });
    expect(events).toEqual(["delete-vectors:chunk-a,chunk-b", "forget-document:7"]);
  });

  it("treats a document that is not indexable as a removal, whatever the intent said", async () => {
    const events: string[] = [];
    const state = recordingState(events, { existing: { documentId: 9, key: ".trash/a.md", status: "ready", desired: null, desiredChunkCount: 1, active: null, activeChunkCount: 1, updatedAt: 1, attempts: 0, lastError: null }, chunkIds: ["chunk-x"] });

    const result = await applyVectorIntent(deps(events, { state, lookupDocument: () => ({ id: 9 }) }), { path: ".trash/a.md", action: "upsert" });

    expect(result).toMatchObject({ applied: true, status: "removed" });
    expect(events).toEqual(["delete-vectors:chunk-x", "forget-document:9"]);
  });

  it("publishes instead of removing when R2 still holds the file, whatever the intent said", async () => {
    const events: string[] = [];
    // An intent to remove is a hint, never an instruction: the audit's delete candidates go through the
    // same method, and an audit's page can be wrong about a path that was rewritten while it walked.
    const result = await applyVectorIntent(deps(events), { path: "notes/a.md", action: "remove" });
    expect(result).toMatchObject({ applied: true, status: "published" });
  });

  it("is a no-op for a removal of a document that was never vectorized", async () => {
    const events: string[] = [];
    const result = await applyVectorIntent(deps(events, { readObject: async () => null }), { path: "notes/never-vectorized.md", action: "remove" });
    expect(result).toMatchObject({ applied: true, status: "empty" });
    expect(events).toEqual([]);
  });
});

describe("collecting garbage", () => {
  it("deletes the superseded vectors before forgetting their ledger rows", async () => {
    const events: string[] = [];
    const state = recordingState(events, { stale: [{ chunkId: "old-1", documentId: 7 }, { chunkId: "old-2", documentId: 7 }] });

    const collected = await collectVectorGarbage({ state, deleteVectors: async ids => { events.push(`delete-vectors:${ids.join(",")}`); }, forgetChunks: (port, ids) => port.forgetChunks(ids) }, 64);

    expect(collected).toBe(2);
    expect(events).toEqual(["delete-vectors:old-1,old-2", "forget-chunks:old-1,old-2"]);
  });

  it("does nothing when the ledger only claims the active revision", async () => {
    const events: string[] = [];
    const collected = await collectVectorGarbage({ state: recordingState(events), deleteVectors: async () => { throw new Error("must not be called"); }, forgetChunks: () => { throw new Error("must not be called"); } }, 64);
    expect(collected).toBe(0);
  });
});
