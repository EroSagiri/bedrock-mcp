import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../apps/vault/src/vector/sha256";
import { assignChunkIds, canonicalChunkIdentity, chunkDocument, chunkIdFor, embeddingText } from "../apps/vault/src/vector/chunk";
import { parseDocument } from "../apps/vault/src/index/parse";
import { legacySha256Base64Url } from "./vector-sha256-oracle";

/** FIPS 180-4 vectors, so the digest is anchored to the standard and not only to the oracle. */
const KNOWN_ANSWERS: Array<[string, string]> = [
  ["", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"],
  ["abc", "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "JI1qYdIGOLjlwCaTDD5gOaM85Flk_yFn9uzt1BnbBsE"],
];

describe("the vector digest", () => {
  /**
   * Every id the vector index has ever written came out of the retired synchronous implementation, and
   * the id is a physical key: a silent change would leave the stored vectors unreachable rather than
   * producing a wrong answer. So the replacement is compared against the old arithmetic directly, over
   * lengths that exercise all three padding cases.
   */
  it("matches the retired synchronous implementation exactly", async () => {
    const inputs = [
      ...KNOWN_ANSWERS.map(([input]) => input),
      "a", "ab", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65),
      "x".repeat(119), "x".repeat(120), "x".repeat(1000),
      "中文内容与 emoji 🧪 混排",
    ];
    for (const input of inputs) {
      expect(await sha256Base64Url(input), `length ${input.length}`).toBe(legacySha256Base64Url(input));
    }
  });

  it("produces the standard digests", async () => {
    for (const [input, expected] of KNOWN_ANSWERS) expect(await sha256Base64Url(input)).toBe(expected);
  });
});

describe("chunk identity is content-addressed", () => {
  it("carries document, content, chunker, model and schema version", async () => {
    const base = { documentId: 42, contentSha256: "a".repeat(64), ordinal: 0 };
    const id = await chunkIdFor(base);
    expect(id).toHaveLength(32);
    expect(id).not.toBe(await chunkIdFor({ ...base, ordinal: 1 }));
    expect(id).not.toBe(await chunkIdFor({ ...base, documentId: 43 }));
    expect(id).not.toBe(await chunkIdFor({ ...base, contentSha256: "b".repeat(64) }));
    // A new chunker or a new model is a different id space, not a reused one.
    expect(id).not.toBe(await chunkIdFor({ ...base, chunkerVersion: 2 }));
    expect(id).not.toBe(await chunkIdFor({ ...base, embeddingModel: "@cf/baai/bge-m3" }));
    expect(id).not.toBe(await chunkIdFor({ ...base, vectorVersion: 2 }));
    // Length-prefixing means no field boundary can be forged by a value that contains the separator.
    const identity = { ...base, chunkerVersion: 1, embeddingModel: "m", vectorVersion: 1 };
    expect(canonicalChunkIdentity({ ...identity, contentSha256: "1|2" })).not.toBe(canonicalChunkIdentity({ ...identity, contentSha256: "1", ordinal: 2 }));
  });

  it("is derived before the transaction, not inside it", async () => {
    const parsed = parseDocument("notes/a.md", "# Top\n\nintro");
    const drafts = chunkDocument(parsed);
    // The chunker itself is pure structure: no identity, nothing to await.
    expect(drafts).toEqual([{ ordinal: 0, heading: "Top", text: "intro" }]);
    const chunks = await assignChunkIds(drafts, { documentId: 7, contentSha256: "c".repeat(64) });
    expect(chunks[0]!.chunkId).toBe(await chunkIdFor({ documentId: 7, contentSha256: "c".repeat(64), ordinal: 0 }));
    expect(chunks[0]!.contentSha256).toBe("c".repeat(64));
  });
});

describe("chunking a document", () => {
  const source = ["---", "tags: [mineral, sync]", "---", "# Top", "", "intro paragraph", "", "## Section A", "", "aaa", "", "## Section B", "", "bbb"].join("\n");

  it("splits on headings and keeps them as context", () => {
    const parsed = parseDocument("notes/a.md", source);
    const chunks = chunkDocument(parsed);

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
    const chunks = chunkDocument(parsed);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1500);
    // Nothing is lost: the pieces together cover the whole body.
    expect(chunks.map(chunk => chunk.text).join("").replace(/\s/g, "").length).toBeGreaterThanOrEqual(3900);
  });

  it("gives a body-less document one chunk so its title is still searchable", () => {
    const parsed = parseDocument("notes/empty.md", "");
    const chunks = chunkDocument(parsed);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("empty");
  });
});
