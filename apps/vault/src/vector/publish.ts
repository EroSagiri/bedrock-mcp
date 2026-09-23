import { isIndexable } from "../index/indexable";
import { parseDocument } from "../index/parse";
import { assignChunkIds, chunkDocument, embeddingText } from "./chunk";
import { sameRevision, revisionFor, type VectorRevision } from "./schema";
import type { SqlVectorStore, VectorChunkRow, VectorDocumentState } from "./store";

/**
 * The ledger and state operations the publish path needs.
 *
 * It is the subset of `SqlVectorStore` this module touches, named separately so the *ordering* of a
 * publish can be tested against a recording double: the SQL is exercised through the Durable Object,
 * where the real engine is, and the sequence is exercised here, where it is visible.
 */
export type VectorStatePort = {
  stateForDocument(documentId: number): VectorDocumentState | undefined;
  stateForKey(key: string): VectorDocumentState | undefined;
  beginAttempt(documentId: number, key: string, desired: VectorRevision, chunkCount: number, now: number): void;
  recordNoop(documentId: number, desired: VectorRevision, now: number): void;
  publishRevision(documentId: number, key: string, revision: VectorRevision, chunks: VectorChunkRow[], now: number): void;
  chunkIdsOfDocument(documentId: number): string[];
  staleLedger(limit: number): Array<{ chunkId: string; documentId: number }>;
  forgetChunks(chunkIds: string[]): void;
  forgetDocument(documentId: number): void;
};

/**
 * The outcome of one vector intent.
 *
 * `deferred` is deliberately separate from failure. Two conditions are not errors at all — the note index
 * has not published the document yet, and R2 moved on while the vectors were being computed — and both
 * resolve on their own, so they must not consume the failure backoff or show up as an error.
 */
export type VectorApplyResult =
  | { applied: true; status: "published" | "removed" | "noop"; chunks: number }
  | { applied: true; status: "empty" }
  | { applied: false; deferred: true; error: string }
  | { applied: false; deferred?: false; error: string };

/** One vector as Vectorize takes it. Metadata is minimal and never carries a path. */
export type VectorRecord = { id: string; values: number[]; metadata: { content_sha256: string; ordinal: number } };

export type VectorPublishDeps = {
  state: VectorStatePort;
  /** R2 read, plus the etag the revision was read at. */
  readObject(path: string): Promise<{ text: string; etag: string } | null>;
  /** A revision check that does not transfer the body, used to detect a move during embedding. */
  observeEtag(path: string): Promise<string | null>;
  /** The note index's row, which is where `document_id` comes from. */
  lookupDocument(key: string): { id: number } | undefined;
  digest(text: string): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
  upsert(records: VectorRecord[]): Promise<unknown>;
  deleteVectors(ids: string[]): Promise<unknown>;
  /** Writes the ledger and the state row in one transaction. */
  publish(state: VectorStatePort, documentId: number, key: string, revision: VectorRevision, chunks: VectorChunkRow[], now: number): void;
  /** Removes a document's ledger and state rows in one transaction. */
  forget(state: VectorStatePort, documentId: number): void;
  forgetChunks(state: VectorStatePort, chunkIds: string[]): void;
  now(): number;
};

/**
 * Brings one document's vectors in line with R2, or removes them.
 *
 * The ordering is the contract, and it is the reason this is one function:
 *
 *   1. chunk and identify — outside any transaction, with awaited digests;
 *   2. `beginAttempt` — so an interrupted publish is visible as a desired revision with no active one;
 *   3. embed and upsert — Vectorize is written **first**;
 *   4. publish — one transaction writes the ledger rows and the state row that makes them servable.
 *
 * Step 3 before step 4 is what makes an interrupted publish safe: chunk ids are content-addressed, so a
 * revision that was upserted but never published is invisible to search (no ledger row, and the active
 * revision still points at the previous content hash) and is simply re-upserted by the retry, which
 * computes exactly the same ids.
 */
export async function applyVectorIntent(
  deps: VectorPublishDeps,
  intent: { path: string; action: "upsert" | "remove" },
): Promise<VectorApplyResult> {
  if (!isIndexable(intent.path)) return removeDocument(deps, intent.path);
  const object = await deps.readObject(intent.path);
  if (!object) return removeDocument(deps, intent.path);

  // The ledger's only link to a note is `document_id`, so a document the note index has not published
  // yet cannot be given vectors: there would be nothing for a hit to be validated against.
  const document = deps.lookupDocument(intent.path);
  if (!document) return { applied: false, deferred: true, error: "not yet in the note index" };

  const contentSha256 = await deps.digest(object.text);
  const desired = revisionFor(contentSha256);
  const parsed = parseDocument(intent.path, object.text);
  const chunks = await assignChunkIds(chunkDocument(parsed), { documentId: document.id, contentSha256 });

  // A re-write of identical bytes is a new revision but not new vectors: the ids are a function of the
  // content hash, so re-embedding would produce exactly the same values. Advancing the intent is enough.
  const existing = deps.state.stateForDocument(document.id);
  if (existing?.status === "ready" && sameRevision(existing.active, desired)) {
    deps.state.recordNoop(document.id, desired, deps.now());
    return { applied: true, status: "noop", chunks: chunks.length };
  }

  deps.state.beginAttempt(document.id, intent.path, desired, chunks.length, deps.now());

  const vectors = await deps.embed(chunks.map(chunk => embeddingText(parsed, chunk)));
  if (vectors.length !== chunks.length) {
    throw new Error(`embedding count mismatch: asked for ${chunks.length}, received ${vectors.length}`);
  }

  // Embedding takes long enough for the file to change underneath it. Publishing the revision we read
  // would then overwrite a newer one, so the revision is re-checked and the work is simply re-done.
  const observed = await deps.observeEtag(intent.path);
  if (observed !== object.etag) return { applied: false, deferred: true, error: "revision moved while embedding" };

  await deps.upsert(chunks.map((chunk, index) => ({
    id: chunk.chunkId,
    values: vectors[index]!,
    metadata: { content_sha256: contentSha256, ordinal: chunk.ordinal },
  })));

  deps.publish(
    deps.state,
    document.id,
    intent.path,
    desired,
    chunks.map(chunk => ({ chunkId: chunk.chunkId, ordinal: chunk.ordinal, heading: chunk.heading, text: chunk.text })),
    deps.now(),
  );
  return { applied: true, status: "published", chunks: chunks.length };
}

/**
 * Deletes a document's vectors.
 *
 * The ledger is the only cleanup record, so the order is fixed: read the ids, delete the vectors, and
 * only then forget the rows. A crash anywhere leaves the ledger intact and the work is redone — and
 * deleting an id that is already gone from Vectorize is a no-op, so a retry is always safe.
 */
async function removeDocument(deps: VectorPublishDeps, path: string): Promise<VectorApplyResult> {
  const state = deps.state.stateForKey(path);
  if (!state) return { applied: true, status: "empty" };
  const ids = deps.state.chunkIdsOfDocument(state.documentId);
  if (ids.length > 0) await deps.deleteVectors(ids);
  deps.forget(deps.state, state.documentId);
  return { applied: true, status: "removed", chunks: ids.length };
}

/**
 * Collects vectors the ledger no longer claims for any active revision.
 *
 * These are the chunks of a superseded revision, and the leftovers of an interrupted removal. Both are
 * found by comparing the ledger with the state and never by walking Vectorize, which has no listing API
 * — which is precisely why a ledger row is deleted last everywhere in this module.
 */
export async function collectVectorGarbage(deps: Pick<VectorPublishDeps, "state" | "deleteVectors" | "forgetChunks">, limit: number): Promise<number> {
  const stale = deps.state.staleLedger(limit);
  if (stale.length === 0) return 0;
  const ids = stale.map(row => row.chunkId);
  await deps.deleteVectors(ids);
  deps.forgetChunks(deps.state, ids);
  return ids.length;
}
