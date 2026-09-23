import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../apps/vault/src/vector/sha256";
import { canonicalChunkIdentity, chunkDocument, chunkIdFor, embeddingText } from "../apps/vault/src/vector/chunk";
import { parseDocument } from "../apps/vault/src/index/parse";

/**
 * The digest is hand-written arithmetic, so it is checked against the runtime's own implementation.
 * It is the basis of every physical vector id, and a wrong digest would be silently wrong: ids would
 * be stable and unique, just not what the contract says they are.
 */
const webcrypto = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("the synchronous SHA-256 matches the runtime", () => {
  it("agrees on known vectors and on awkward lengths", async () => {
    // "abc" is the canonical FIPS vector; the rest cover the padding edges of the block loop.
    expect(sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    for (const text of ["", "a", "ab", "abcd", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "x".repeat(1000), "中文内容与 emoji 🧪 混排"]) {
      expect(sha256Base64Url(text), `length ${text.length}`).toBe(await webcrypto(text));
    }
  });
});

describe("chunk identity is content-addressed", () => {
  it("carries document, content, chunker, model and schema version", () => {
    const base = { documentId: 42, contentSha256: "a".repeat(64), ordinal: 0 };
    const id = chunkIdFor(base);
    expect(id).toHaveLength(32);
    expect(id).not.toBe(chunkIdFor({ ...base, ordinal: 1 }));
    expect(id).not.toBe(chunkIdFor({ ...base, documentId: 43 }));
    expect(id).not.toBe(chunkIdFor({ ...base, contentSha256: "b".repeat(64) }));
    // A new chunker or a new model is a different id space, not a reused one.
    expect(id).not.toBe(chunkIdFor({ ...base, chunkerVersion: 2 }));
    expect(id).not.toBe(chunkIdFor({ ...base, embeddingModel: "@cf/baai/bge-m3" }));
    expect(id).not.toBe(chunkIdFor({ ...base, vectorVersion: 2 }));
    // Length-prefixing means no field boundary can be forged by a value that contains the separator.
    const identity = { ...base, chunkerVersion: 1, embeddingModel: "m", vectorVersion: 1 };
    expect(canonicalChunkIdentity({ ...identity, contentSha256: "1|2" })).not.toBe(canonicalChunkIdentity({ ...identity, contentSha256: "1", ordinal: 2 }));
  });
});

describe("chunking a document", () => {
  const source = ["---", "tags: [mineral, sync]", "---", "# Top", "", "intro paragraph", "", "## Section A", "", "aaa", "", "## Section B", "", "bbb"].join("\n");

  it("splits on headings and keeps them as context", () => {
    const parsed = parseDocument("notes/a.md", source);
    const chunks = chunkDocument(parsed, { documentId: 7, contentSha256: "c".repeat(64) });

    expect(chunks.map(chunk => chunk.heading)).toEqual(["Top", "Section A", "Section B"]);
    expect(chunks.map(chunk => chunk.ordinal)).toEqual([0, 1, 2]);
    // The embedding input labels the passage and never contains the raw YAML.
    const text = embeddingText(parsed, chunks[1]!);
    expect(text).toContain("Title: Top");
    expect(text).toContain("Heading: Section A");
    expect(text).toContain("Tags: mineral, sync");
    expect(text).not.toContain("tags: [mineral, sync]");
  });

  it("hard-splits an over-long section instead of letting the model truncate it", () => {
    const parsed = parseDocument("notes/long.md", `# Long\n\n${"x".repeat(4000)}`);
    const chunks = chunkDocument(parsed, { documentId: 8, contentSha256: "d".repeat(64) });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1500);
    // Nothing is lost: the pieces together cover the whole body.
    expect(chunks.map(chunk => chunk.text).join("").replace(/\s/g, "").length).toBeGreaterThanOrEqual(3900);
  });

  it("gives a body-less document one chunk so its title is still searchable", () => {
    const parsed = parseDocument("notes/empty.md", "");
    const chunks = chunkDocument(parsed, { documentId: 9, contentSha256: "e".repeat(64) });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("empty");
  });
});

