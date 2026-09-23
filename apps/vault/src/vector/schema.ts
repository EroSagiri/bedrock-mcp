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
