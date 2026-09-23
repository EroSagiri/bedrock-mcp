import type { VectorizeBinding } from "../apps/vault/src/durable/vault-index";

/**
 * An in-memory Vectorize, for tests.
 *
 * Miniflare has no local Vectorize: the binding is remote-only, so any test that reaches the vector
 * publish path would otherwise need real credentials and would write to a real index. This stands in for
 * the platform, with the parts that matter — id-keyed upsert, id-based delete, and a cosine query that
 * really ranks — while SQLite, the state machine and the acceptance rule stay the real thing.
 *
 * It is created per Durable Object instance, so it needs no shared module state: everything a test wants
 * to know is observable through the Vault's own RPC surface.
 */
export type FakeVectorize = VectorizeBinding & {
  /** The ids currently held, for a test that wants to assert on the collection directly. */
  ids(): string[];
  size(): number;
  clear(): void;
};

export function createFakeVectorize(options: { metric?: "cosine" | "dot-product" | "euclidean" } = {}): FakeVectorize {
  const metric = options.metric ?? "cosine";
  const held = new Map<string, { values: number[]; metadata?: Record<string, unknown> }>();
  const similarity = (left: number[], right: number[]): number => {
    if (metric === "euclidean") return -Math.sqrt(left.reduce((sum, value, index) => sum + (value - (right[index] ?? 0)) ** 2, 0));
    const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
    if (metric === "dot-product") return dot;
    const norm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) * Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? 0 : dot / norm;
  };
  return {
    async upsert(vectors) {
      for (const vector of vectors) held.set(vector.id, { values: vector.values, ...(vector.metadata ? { metadata: vector.metadata } : {}) });
      return { mutationId: `fake-${held.size}` };
    },
    async deleteByIds(ids) {
      for (const id of ids) held.delete(id);
      return { mutationId: `fake-${held.size}` };
    },
    async query(vector, queryOptions) {
      const topK = queryOptions?.topK ?? 10;
      const matches = [...held.entries()]
        .map(([id, entry]) => ({ id, score: similarity(vector, entry.values) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, topK);
      return { matches };
    },
    ids: () => [...held.keys()],
    size: () => held.size,
    clear: () => held.clear(),
  };
}
