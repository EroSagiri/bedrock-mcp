/**
 * The physical contract of the vector index.
 *
 * Model, dimensions and metric are properties of the **index**, not of the code that fills it: a
 * Vectorize index is created with its width and metric once and cannot change them, and two embedding
 * models do not share a vector space even at the same width. So these values live in one place, are
 * reported by the health endpoint, and changing any of them is a vector migration — a new index and a
 * backfill — never an in-place overwrite.
 */
export const VECTOR_SCHEMA = {
  version: 1,
  model: "@cf/qwen/qwen3-embedding-0.6b",
  dimensions: 1024,
  metric: "cosine",
  chunkerVersion: 1,
} as const;

/**
 * Chunk sizing, in Unicode characters.
 *
 * A section is split further when it exceeds the target, and never left longer than the hard maximum:
 * the model truncates silently past its context, which would produce an embedding that describes only
 * the beginning of a long note.
 */
export const CHUNK_TARGET_CHARS = 1000;
export const CHUNK_MAX_CHARS = 1500;
export const CHUNK_OVERLAP_CHARS = 150;

/**
 * What "the vectors for this document are current" means.
 *
 * It is **not** the file's etag. A vector is a function of the text, the chunker that cut it, and the
 * model that encoded it; the revision the file happens to carry is irrelevant to whether the stored
 * vectors are the right ones. That is why re-writing a note with identical bytes must not re-embed it,
 * and why changing the chunker must.
 */
export type VectorRevision = {
  contentSha256: string;
  chunkerVersion: number;
  embeddingModel: string;
  vectorVersion: number;
};

/** The revision the frozen schema would produce for a given content hash. */
export function revisionFor(contentSha256: string): VectorRevision {
  return {
    contentSha256,
    chunkerVersion: VECTOR_SCHEMA.chunkerVersion,
    embeddingModel: VECTOR_SCHEMA.model,
    vectorVersion: VECTOR_SCHEMA.version,
  };
}

export function sameRevision(left: VectorRevision | null | undefined, right: VectorRevision | null | undefined): boolean {
  if (!left || !right) return false;
  return left.contentSha256 === right.contentSha256
    && left.chunkerVersion === right.chunkerVersion
    && left.embeddingModel === right.embeddingModel
    && left.vectorVersion === right.vectorVersion;
}

/** Whether a published revision was produced by the chunker and model this build compiles in. */
export function isCurrentRevision(revision: VectorRevision | null | undefined): boolean {
  return !!revision
    && revision.chunkerVersion === VECTOR_SCHEMA.chunkerVersion
    && revision.embeddingModel === VECTOR_SCHEMA.model
    && revision.vectorVersion === VECTOR_SCHEMA.version;
}

/**
 * The identity of the physical index, as opposed to the identity of one revision.
 *
 * Recorded the first time anything is published. Model, width and metric cannot be changed on an
 * existing Vectorize index, so if the compiled-in schema ever disagrees with what is recorded, the
 * deployment is pointing at an index built for a different embedding function. Publishing into it would
 * mix two incomparable vector spaces, which is silent and unfixable; the drain refuses instead.
 */
export function vectorIndexSchema(): { model: string; dimensions: number; metric: string; version: number } {
  return { model: VECTOR_SCHEMA.model, dimensions: VECTOR_SCHEMA.dimensions, metric: VECTOR_SCHEMA.metric, version: VECTOR_SCHEMA.version };
}
