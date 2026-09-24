import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";

/**
 * Finding a tag, which is what a tag search is.
 *
 * The index answers this exactly, so the only questions worth pinning are the ones a caller actually has:
 * a half-remembered name, and a name that contains a character `LIKE` would otherwise read as syntax.
 */
type IndexStub = {
  resetMutationState(): Promise<void>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
};

const index = () => vaultIndex() as unknown as IndexStub;
const encoder = new TextEncoder();
const query = async (kind: string, input: Record<string, unknown> = {}) =>
  (await (await index().fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind, ...input }) }))).json()) as Record<string, unknown>;
const tagNames = (result: Record<string, unknown>) => (result.tags as Array<{ tag: string }>).map(item => item.tag);

const DOCUMENTS = {
  "tags/running.md": "---\ntags: [跑步, 训练/跑步]\n---\n\n跑步记录。\n",
  "tags/inline.md": "正文里提到 #跑步 以及 #骑行 一次。\n",
  "tags/percent.md": "---\ntags: [\"100%\", \"a_b\"]\n---\n\n特殊字符标签。\n",
};

describe("searching tags", () => {
  it("answers the index's view of every tag", async () => {
    const stub = index();
    await stub.resetMutationState();
    for (const [key, body] of Object.entries(DOCUMENTS)) await bindings().MINERAL.put(key, encoder.encode(body));
    for (const key of Object.keys(DOCUMENTS)) await stub.applyIndexIntent({ path: key, action: "upsert" });

    const all = await query("tags", {});
    expect(tagNames(all)).toContain("跑步");
    expect(tagNames(all)).toContain("训练/跑步");
    // A tag written in the body is a tag too, and the sources are counted separately.
    const body = await query("tags", { sources: ["body"] });
    expect(tagNames(body).sort()).toEqual(["骑行", "跑步"].sort());
  });

  it("matches a fragment of a name, which a prefix cannot", async () => {
    const stub = index();
    await stub.resetMutationState();
    for (const [key, body] of Object.entries(DOCUMENTS)) await bindings().MINERAL.put(key, encoder.encode(body));
    for (const key of Object.keys(DOCUMENTS)) await stub.applyIndexIntent({ path: key, action: "upsert" });

    // `跑` is a prefix here, but `步` is not — and `步` is exactly what someone who forgot the first
    // character types.
    expect(tagNames(await query("tags", { tagContains: "步" }))).toContain("跑步");
    expect(tagNames(await query("tags", { tagPrefix: "跑" }))).toContain("跑步");
    expect(tagNames(await query("tags", { tagContains: "训练/" }))).toEqual(["训练/跑步"]);
  });

  it("treats a wildcard character as a character", async () => {
    const stub = index();
    await stub.resetMutationState();
    for (const [key, body] of Object.entries(DOCUMENTS)) await bindings().MINERAL.put(key, encoder.encode(body));
    for (const key of Object.keys(DOCUMENTS)) await stub.applyIndexIntent({ path: key, action: "upsert" });

    // Unescaped, `%` would match every tag and `_` would match any single character.
    expect(tagNames(await query("tags", { tagContains: "100%" }))).toEqual(["100%"]);
    expect(tagNames(await query("tags", { tagContains: "a_b" }))).toEqual(["a_b"]);
    expect(tagNames(await query("tags", { tagContains: "a%b" }))).toEqual([]);
  });

  it("finds the documents that carry a tag, and separates a tag from its children", async () => {
    const stub = index();
    await stub.resetMutationState();
    for (const [key, body] of Object.entries(DOCUMENTS)) await bindings().MINERAL.put(key, encoder.encode(body));
    for (const key of Object.keys(DOCUMENTS)) await stub.applyIndexIntent({ path: key, action: "upsert" });

    expect((await query("tag-documents", { tag: "跑步" })).documents).toHaveLength(2);
    expect(((await query("tag-documents", { tag: "训练", match: "descendants" })).documents as unknown[])).toHaveLength(1);
  });
});
