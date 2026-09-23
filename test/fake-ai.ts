/**
 * A deterministic stand-in for the Workers AI embedding binding.
 *
 * Used only by tests: it returns vectors of a configurable width so the probe's arithmetic — and, more
 * importantly, its *refusals* — can be exercised without a network call or a model.
 *
 * The vector is a hashed bag of words rather than noise, so cosine similarity between two of them means
 * something: texts that share vocabulary really are closer. That is what lets a semantic search test
 * assert that the matching note ranks first, instead of asserting whatever an arbitrary ranking produced.
 * It is still not an embedding — there is no semantics here, only shared tokens.
 */
export const FAKE_EMBEDDING_DIMENSIONS = 1024;

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (const character of text) {
    value = (value ^ (character.codePointAt(0) ?? 0)) >>> 0;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** Latin runs stay whole; each CJK character is its own token, which is how a real tokenizer behaves. */
function tokensOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]/g) ?? [];
}

export function fakeEmbeddingVector(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokensOf(text)) {
    const bucket = hash(token) % dimensions;
    vector[bucket]! += (hash(`${token}\u0000sign`) & 1) === 0 ? 1 : -1;
  }
  // A text with no tokens has no direction at all; give it a deterministic one so cosine stays defined.
  if (!vector.some(value => value !== 0)) vector[hash(text) % dimensions] = 1;
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
 * `dimensions` is the knob the probe tests turn; `envelope` covers a runtime that answers in a shape the
 * probe has not seen before; `constant` simulates a binding that answers without encoding anything.
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
