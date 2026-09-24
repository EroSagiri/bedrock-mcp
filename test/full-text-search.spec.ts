import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";
import { planTextQuery } from "../apps/vault/src/index/text-query";

/**
 * Full-text search over a Chinese vault.
 *
 * The engine's tokenizer is word-oriented, so a run of CJK characters between two punctuation marks is a
 * single token: searching 心率 cannot match "实时查看心率的工具" through FTS5 at all. These pin the
 * behaviour the search box actually needs — a word inside a sentence is findable — and the other half of
 * the same problem, that a query is not an FTS5 expression.
 */
type IndexStub = {
  resetMutationState(): Promise<void>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
};

const index = () => vaultIndex() as unknown as IndexStub;
const encoder = new TextEncoder();
const search = async (query: string, input: Record<string, unknown> = {}) =>
  (await (await index().fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind: "search", query, ...input }) }))).json()) as {
    results: Array<{ key: string; title: string | null; snippet: string; score: number }>;
    ranking?: string;
    partial: boolean;
  };

async function seed(documents: Record<string, string>) {
  const stub = index();
  await stub.resetMutationState();
  for (const [key, body] of Object.entries(documents)) await bindings().MINERAL.put(key, encoder.encode(body));
  for (const key of Object.keys(documents)) await stub.applyIndexIntent({ path: key, action: "upsert" });
}

describe("planning a search query", () => {
  it("splits Latin terms from CJK runs", () => {
    expect(planTextQuery("心率 monitor")).toMatchObject({ match: '"monitor"', cjkRuns: ["心率"], anchor: "心率", hasCjk: true, empty: false });
    expect(planTextQuery("quartz")).toMatchObject({ match: '"quartz"', cjkRuns: [], hasCjk: false, empty: false });
  });

  it("never hands FTS5 syntax to FTS5", () => {
    // Unquoted, `probe-tag` is `probe NOT tag`, an unbalanced quote is a syntax error, and `*` or `:` are
    // operators. A search box means a search box.
    expect(planTextQuery("probe-tag").match).toBe('"probe" AND "tag"');
    expect(planTextQuery('"unclosed').match).toBe('"unclosed"');
    expect(planTextQuery("a*b").match).toBe('"a" AND "b"');
    expect(planTextQuery("field:value").match).toBe('"field" AND "value"');
    expect(planTextQuery("C++").match).toBe('"C"');
  });

  it("keeps a deliberate operator, and drops a dangling one", () => {
    expect(planTextQuery("foo OR bar").match).toBe('"foo" OR "bar"');
    expect(planTextQuery("NOT foo").match).toBe('"foo"');
    expect(planTextQuery("foo AND").match).toBe('"foo"');
  });

  it("reports a query with nothing searchable in it", () => {
    expect(planTextQuery("   ")).toMatchObject({ empty: true, match: null });
    expect(planTextQuery("!!! ... ???")).toMatchObject({ empty: true, match: null });
  });

  it("anchors on the longest CJK run", () => {
    expect(planTextQuery("跑步 麦理浩径").anchor).toBe("麦理浩径");
  });
});

describe("searching Chinese text", () => {
  it("finds a word that appears inside a sentence", async () => {
    await seed({
      "search/cjk.md": "下午回来整了个实时查看心率的工具，通过手机桥接手表。",
      "search/other.md": "今天只是普通的记录，没有任何相关的内容。",
    });

    const found = await search("心率");
    expect(found.ranking).toBe("phrase");
    expect(found.results.map(result => result.key)).toEqual(["search/cjk.md"]);
    // The snippet is anchored on the match rather than being the head of the note.
    expect(found.results[0]!.snippet).toContain("心率");
  });

  it("finds a longer phrase, and a run that is only part of one", async () => {
    await seed({ "search/trail.md": "麦理浩径徒步记录，全程四十公里。" });

    expect((await search("麦理浩径")).results.map(result => result.key)).toEqual(["search/trail.md"]);
    expect((await search("理浩径")).results.map(result => result.key)).toEqual(["search/trail.md"]);
    expect((await search("徒步")).results.map(result => result.key)).toEqual(["search/trail.md"]);
  });

  it("requires every run of a multi-word query", async () => {
    await seed({
      "search/both.md": "麦理浩径的徒步记录。",
      "search/one.md": "麦理浩径的交通记录。",
    });

    expect((await search("麦理浩径 徒步")).results.map(result => result.key)).toEqual(["search/both.md"]);
  });

  it("finds a note by a Chinese tag, because the tags are searchable text too", async () => {
    await seed({ "search/tagged.md": "---\ntags: [跑步, 日记]\n---\n\n今天状态一般。\n" });

    expect((await search("跑步")).results.map(result => result.key)).toEqual(["search/tagged.md"]);
  });

  it("ranks a heading hit above a body-only hit", async () => {
    await seed({
      "search/heading.md": "# 心率训练\n\n别的什么也没有。\n",
      "search/body.md": "随便写点什么，末尾提了一句心率。\n",
    });

    const results = (await search("心率")).results;
    expect(results.map(result => result.key)).toEqual(["search/heading.md", "search/body.md"]);
  });

  it("respects a prefix, and answers an empty result rather than an error", async () => {
    await seed({ "search/daily/a.md": "心率记录", "search/notes/b.md": "心率记录" });

    expect((await search("心率", { prefix: "search/daily/" })).results.map(result => result.key)).toEqual(["search/daily/a.md"]);
    expect((await search("不存在的词")).results).toEqual([]);
    expect((await search("。。。")).results).toEqual([]);
  });

  it("mixes a Latin term with a Chinese run", async () => {
    await seed({
      "search/mixed.md": "用 quartz 记录心率的方式。",
      "search/only-latin.md": "quartz 生成静态页面。",
    });

    expect((await search("quartz 心率")).results.map(result => result.key)).toEqual(["search/mixed.md"]);
  });
});

describe("searching Latin text", () => {
  it("still answers from FTS5, and says so", async () => {
    await seed({
      "search/latin.md": "The mineral pipeline writes quartz bundles every night.\n",
      "search/decoy.md": "Nothing to do with the other note.\n",
    });

    const found = await search("quartz");
    expect(found.ranking).toBe("bm25");
    expect(found.results.map(result => result.key)).toEqual(["search/latin.md"]);
    expect(found.results[0]!.snippet).toContain("quartz");
  });

  it("treats a hyphen as a separator instead of FTS5's NOT operator", async () => {
    await seed({ "search/hyphen.md": "---\ntags: [probe-tag]\n---\n\nA note about the probe and its tag.\n" });

    // Unquoted this is `probe NOT tag`, which finds nothing at all.
    expect((await search("probe-tag")).results.map(result => result.key)).toEqual(["search/hyphen.md"]);
  });

  it("does not let a malformed query reach the parser", async () => {
    await seed({ "search/quotes.md": "unclosed parenthesis and a quote\n" });

    for (const query of ['"unclosed', "NEAR(", "a AND", "^caret", "trailing:"]) {
      const found = await search(query);
      expect(Array.isArray(found.results), query).toBe(true);
    }
  });
});
