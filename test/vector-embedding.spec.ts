import { describe, expect, it } from "vitest";
import { createFakeAi, fakeEmbeddingVector } from "./fake-ai";
import { describeEmbeddingOutput, embeddingInputCandidates, PROBE_TEXTS, runEmbeddingProbe, vectorsOf } from "../apps/vault/src/vector/embedding";
import { VECTOR_SCHEMA } from "../apps/vault/src/vector/schema";
import { vaultEntrypoint } from "./support";

describe("reading an embedding response", () => {
  it("finds the vectors in each envelope a text-embedding model has answered in", () => {
    const expected = { dimensions: 3, vectorCount: 2, uniform: true, finite: true };
    // The shape that the documented models return.
    expect(describeEmbeddingOutput({ shape: [2, 3], data: [[1, 2, 3], [4, 5, 6]] })).toEqual({ envelope: "data", ...expected });
    // A bare array of vectors, and a bare single vector.
    expect(describeEmbeddingOutput([[1, 2, 3], [4, 5, 6]])).toEqual({ envelope: "root", ...expected });
    expect(describeEmbeddingOutput([1, 2, 3])).toEqual({ envelope: "root", dimensions: 3, vectorCount: 1, uniform: true, finite: true });
    // A single vector under a different name.
    expect(describeEmbeddingOutput({ embedding: [1, 2, 3] })).toEqual({ envelope: "embedding", dimensions: 3, vectorCount: 1, uniform: true, finite: true });
  });

  it("refuses a response it cannot read instead of guessing a width", () => {
    for (const response of [null, undefined, {}, "vectors", { output: { tensors: [] } }, { data: [] }, { data: ["a"] }]) {
      expect(describeEmbeddingOutput(response).dimensions, JSON.stringify(response) ?? "undefined").toBeNull();
      expect(describeEmbeddingOutput(response).envelope).toBe("unrecognised");
    }
  });

  it("does not report a width for a ragged or non-finite response", () => {
    expect(describeEmbeddingOutput({ data: [[1, 2], [3]] }).uniform).toBe(false);
    expect(describeEmbeddingOutput({ data: [[1, Number.NaN]] }).finite).toBe(false);
    expect(vectorsOf({ data: [[1, 2], [3]] }).vectors).toHaveLength(2);
  });
});

describe("probing the embedding model", () => {
  it("accepts a model whose measured width matches the frozen schema", async () => {
    const ai = createFakeAi();
    const result = await runEmbeddingProbe(ai);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.matchesExpectedDimensions).toBe(true);
    expect(result.observed).toEqual({ envelope: "data", vectorCount: 2, dimensions: VECTOR_SCHEMA.dimensions, uniform: true, finite: true });
    expect(result.distinctVectors).toBe(true);
    // The probe asks for the input shape the deployed models document, and the frozen model.
    expect(result.inputShape).toBe("text[]");
    expect(ai.calls).toEqual([{ model: VECTOR_SCHEMA.model, input: { text: [...PROBE_TEXTS] } }]);
  });

  it("refuses a width the index could not be created at", async () => {
    const result = await runEmbeddingProbe(createFakeAi({ dimensions: 768 }));
    expect(result.ok).toBe(false);
    expect(result.matchesExpectedDimensions).toBe(false);
    expect(result.observed.dimensions).toBe(768);
    expect(result.expected.dimensions).toBe(VECTOR_SCHEMA.dimensions);
  });

  it("refuses a model that answers with a constant vector", async () => {
    // A binding that returns the same vector for unrelated texts is not encoding; a similarity search
    // over it would return arbitrary documents, which is worse than returning none.
    const result = await runEmbeddingProbe(createFakeAi({ constant: true }));
    expect(result.ok).toBe(false);
    expect(result.distinctVectors).toBe(false);
    expect(result.matchesExpectedDimensions).toBe(true);
  });

  it("refuses a non-finite response, which would poison every similarity", async () => {
    const result = await runEmbeddingProbe({ run: async () => ({ data: [[Number.NaN, ...fakeEmbeddingVector("x", 1023)]] }) });
    expect(result.ok).toBe(false);
    expect(result.observed.finite).toBe(false);
  });

  it("falls back to a single-text input when the model rejects an array", async () => {
    const calls: unknown[] = [];
    const result = await runEmbeddingProbe({
      async run(_model, input) {
        calls.push(input);
        const text = (input as { text: unknown }).text;
        if (Array.isArray(text)) throw new Error("expected a string");
        return { data: [fakeEmbeddingVector(String(text))] };
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.inputShape).toBe("text");
    expect(result.matchesExpectedDimensions).toBe(true);
    // One text can only prove a width, so the probe says so rather than claiming the model encodes.
    expect(result.distinctVectors).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual(["text[]: expected a string"]);
  });

  it("reports an unreadable response rather than inventing a width", async () => {
    const result = await runEmbeddingProbe(createFakeAi({ envelope: "unknown" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-accepted-input-shape");
    expect(result.observed.dimensions).toBeNull();
    expect(result.errors.every(error => error.includes("no vector"))).toBe(true);
  });

  it("reports a missing binding, because that is a deployment fact and not a failure", async () => {
    const result = await runEmbeddingProbe(undefined);
    expect(result).toMatchObject({ ok: false, reason: "ai-binding-missing", inputShape: null, matchesExpectedDimensions: false });
  });

  it("offers only the input shapes a model has documented", () => {
    expect(embeddingInputCandidates(["a", "b"]).map(candidate => candidate.shape)).toEqual(["text[]", "text"]);
  });
});

describe("the probe over the RPC surface", () => {
  it("is reachable, and measures the width the Vectorize index was created at", async () => {
    // The interesting assertion is that the method survives the RPC boundary at all: a WorkerEntrypoint
    // method that is not public is invisible from here, and the production probe would silently 404.
    const result = await vaultEntrypoint().probeEmbeddingModel!();
    expect(result).toMatchObject({
      ok: true,
      model: VECTOR_SCHEMA.model,
      inputShape: "text[]",
      matchesExpectedDimensions: true,
      observed: { envelope: "data", vectorCount: 2, dimensions: VECTOR_SCHEMA.dimensions },
    });
    expect(result.errors).toEqual([]);
  });
});
