/**
 * A deterministic stand-in for the Workers AI embedding binding.
 *
 * Used only by tests: it returns vectors of a configurable width so the probe's arithmetic — and, more
 * importantly, its *refusals* — can be exercised without a network call or a model. The values are not
 * embeddings; they only have to be text-dependent, finite, and cheap.
 */
export const FAKE_EMBEDDING_DIMENSIONS = 1024;

export function fakeEmbeddingVector(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  let seed = 0x811c9dc5;
  for (const character of text) {
    seed = (seed ^ (character.codePointAt(0) ?? 0)) >>> 0;
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  const vector = new Array<number>(dimensions);
  let state = seed || 1;
  for (let index = 0; index < dimensions; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vector[index] = (state / 0x100000000) * 2 - 1;
  }
  return vector;
}

function textsOf(input: unknown): string[] | null {
  if (!input || typeof input !== "object") return null;
  const text = (input as { text?: unknown }).text;
  if (typeof text === "string") return [text];
  if (Array.isArray(text) && text.every(item => typeof item === "string")) return text as string[];
  return null;
}

export type FakeAi = {
  calls: Array<{ model: string; input: unknown }>;
  run(model: string, input: unknown): Promise<unknown>;
};

/**
 * `dimensions` is the knob the tests turn; `envelope` covers a runtime that answers in a shape the probe
 * has not seen before.
 */
export function createFakeAi(options: { dimensions?: number; envelope?: "shape" | "bare" | "unknown"; constant?: boolean } = {}): FakeAi {
  const dimensions = options.dimensions ?? FAKE_EMBEDDING_DIMENSIONS;
  const calls: FakeAi["calls"] = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const texts = textsOf(input);
      if (!texts) throw new Error("invalid input: expected { text: string | string[] }");
      const data = texts.map(text => (options.constant ? new Array<number>(dimensions).fill(0.5) : fakeEmbeddingVector(text, dimensions)));
      if (options.envelope === "bare") return data;
      if (options.envelope === "unknown") return { output: { tensors: [] } };
      return { shape: [data.length, dimensions], data };
    },
  };
}
