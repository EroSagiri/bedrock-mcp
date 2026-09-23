import { VECTOR_SCHEMA } from "./schema";

/**
 * The Workers AI seam, described structurally.
 *
 * The Vault only ever needs `run`, and keeping the type here rather than depending on the generated
 * binding type means a test can supply its own without pretending to be the platform.
 */
export type EmbeddingBinding = {
  run(model: string, input: unknown): Promise<unknown>;
};

/** What an embedding response was found to contain, whatever envelope it arrived in. */
export type EmbeddingShape = {
  /** Which part of the response the vectors were found in, for diagnosing a changed response schema. */
  envelope: string;
  vectorCount: number;
  dimensions: number | null;
  uniform: boolean;
  /** `false` means the response contained a NaN or an infinity, which would silently poison a metric. */
  finite: boolean;
};

/**
 * The probe texts.
 *
 * Two short, very different strings: long enough to be a real token sequence, and different enough that
 * a model which is not actually encoding shows up as two identical vectors.
 */
export const PROBE_TEXTS = ["mineral vault embedding probe", "synced notes across devices"] as const;

function asVector(value: unknown): number[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "number") ? (value as number[]) : null;
}

/** The parts of a response an embedding could plausibly hide in, outermost first. */
function envelopesOf(response: unknown): Array<[string, unknown]> {
  const candidates: Array<[string, unknown]> = [["root", response]];
  if (response && typeof response === "object" && !Array.isArray(response)) {
    for (const key of ["data", "embedding", "embeddings", "vector", "vectors", "result"]) {
      const value = (response as Record<string, unknown>)[key];
      if (value !== undefined) candidates.push([key, value]);
    }
  }
  return candidates;
}

/**
 * The vectors in a response, and the envelope they were found in.
 *
 * A probe exists to measure, not to confirm: the response envelope is not part of the vector contract,
 * and guessing it would turn "the model changed its response shape" into "the model is unavailable". So
 * every plausible envelope is inspected, and the one that matched is reported.
 */
export function vectorsOf(response: unknown): { envelope: string; vectors: number[][] } {
  for (const [envelope, value] of envelopesOf(response)) {
    const single = asVector(value);
    if (single) return { envelope, vectors: [single] };
    if (Array.isArray(value)) {
      const vectors = value.map(asVector).filter((vector): vector is number[] => vector !== null);
      if (vectors.length) return { envelope, vectors };
    }
  }
  return { envelope: "unrecognised", vectors: [] };
}

export function describeEmbeddingOutput(response: unknown): EmbeddingShape {
  const { envelope, vectors } = vectorsOf(response);
  if (vectors.length === 0) return { envelope, vectorCount: 0, dimensions: null, uniform: false, finite: false };
  const dimensions = vectors[0]!.length;
  return {
    envelope,
    vectorCount: vectors.length,
    dimensions,
    uniform: vectors.every(vector => vector.length === dimensions),
    finite: vectors.every(vector => vector.every(Number.isFinite)),
  };
}

/** The request shapes a text-embedding model on this platform has plausibly accepted. */
export function embeddingInputCandidates(texts: readonly string[]): Array<{ shape: string; input: unknown }> {
  return [
    { shape: "text[]", input: { text: [...texts] } },
    { shape: "text", input: { text: texts[0] } },
  ];
}

export type EmbeddingProbeResult = {
  ok: boolean;
  reason?: string;
  model: string;
  /** Which request shape the binding accepted, or `null` when none did. */
  inputShape: string | null;
  observed: EmbeddingShape;
  expected: { dimensions: number; metric: string; version: number; chunkerVersion: number };
  /** The one thing that must be true before `wrangler vectorize create` can be run. */
  matchesExpectedDimensions: boolean;
  /**
   * Whether two unrelated texts produced different vectors.
   *
   * `null` when the binding could only be asked for one text at a time, in which case the probe is
   * reporting a width and nothing about whether the model encodes.
   */
  distinctVectors: boolean | null;
  elapsedMs: number;
  errors: string[];
};

/**
 * Asks the deployed runtime how wide this model's vectors actually are.
 *
 * The width and metric are baked into a Vectorize index at creation and can never be changed, so a
 * mismatch between the model's real output and the frozen schema has to be discovered *before* the
 * index exists. Documentation is not the measurement; this is.
 */
export async function runEmbeddingProbe(ai: EmbeddingBinding | undefined, model: string = VECTOR_SCHEMA.model): Promise<EmbeddingProbeResult> {
  const started = Date.now();
  const errors: string[] = [];
  const fail = (reason: string): EmbeddingProbeResult => ({
    ok: false,
    reason,
    model,
    inputShape: null,
    observed: { envelope: "unrecognised", vectorCount: 0, dimensions: null, uniform: false, finite: false },
    expected: expectedSchema(),
    matchesExpectedDimensions: false,
    distinctVectors: null,
    elapsedMs: Date.now() - started,
    errors,
  });

  if (!ai?.run) return fail("ai-binding-missing");

  for (const candidate of embeddingInputCandidates(PROBE_TEXTS)) {
    let response: unknown;
    try {
      response = await ai.run(model, candidate.input);
    } catch (error) {
      errors.push(`${candidate.shape}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      continue;
    }
    const observed = describeEmbeddingOutput(response);
    if (observed.envelope === "unrecognised") {
      errors.push(`${candidate.shape}: response contained no vector`);
      continue;
    }
    const { vectors } = vectorsOf(response);
    // Two unrelated texts producing the same vector means the binding answered without encoding.
    const distinctVectors = vectors.length < 2 ? null : !vectors[0]!.every((value, index) => value === vectors[1]![index]);
    return {
      ok: observed.dimensions === VECTOR_SCHEMA.dimensions && observed.uniform && observed.finite && distinctVectors !== false,
      model,
      inputShape: candidate.shape,
      observed,
      expected: expectedSchema(),
      matchesExpectedDimensions: observed.dimensions === VECTOR_SCHEMA.dimensions,
      distinctVectors,
      elapsedMs: Date.now() - started,
      errors,
    };
  }
  return fail("no-accepted-input-shape");
}

function expectedSchema() {
  return {
    dimensions: VECTOR_SCHEMA.dimensions,
    metric: VECTOR_SCHEMA.metric,
    version: VECTOR_SCHEMA.version,
    chunkerVersion: VECTOR_SCHEMA.chunkerVersion,
  };
}

/**
 * How many chunks go into one Workers AI call.
 *
 * The bound is request size, not context: a chunk is capped at 1500 characters, and a batch has to stay
 * comfortably inside what the platform accepts. Most notes are one batch.
 */
export const EMBED_BATCH_SIZE = 8;

/**
 * Embeds chunk texts, refusing anything it cannot line up with the request.
 *
 * The count, width and finiteness checks are the whole value of this function. A vector has to be
 * attached to exactly the chunk it came from, and every similarity in the index assumes all vectors are
 * the same width and none of them is NaN — a silent mismatch would produce a search that returns
 * plausible results for the wrong text, which is worse than an error.
 */
export async function embedTexts(ai: EmbeddingBinding | undefined, texts: readonly string[], model: string = VECTOR_SCHEMA.model): Promise<number[][]> {
  if (!ai?.run) throw new Error("ai-binding-missing");
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    const { envelope, vectors: returned } = vectorsOf(await ai.run(model, { text: [...batch] }));
    if (envelope === "unrecognised") throw new Error("embedding response contained no vector");
    if (returned.length !== batch.length) throw new Error(`embedding count mismatch: asked for ${batch.length}, received ${returned.length}`);
    for (const vector of returned) {
      if (vector.length !== VECTOR_SCHEMA.dimensions) throw new Error(`embedding width ${vector.length} does not match the index width ${VECTOR_SCHEMA.dimensions}`);
      if (!vector.every(Number.isFinite)) throw new Error("embedding contained a non-finite value");
      vectors.push(vector);
    }
  }
  return vectors;
}
