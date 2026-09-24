import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerTagTools } from "../apps/mcp/src/mcp/tools/tags";
import type { Env } from "../apps/mcp/src/types";
import type { VaultClient } from "../apps/mcp/src/vault-client";

/**
 * The tag tools, which are a thin surface over an indexed query.
 *
 * Two things are worth pinning. A tag list can be searched by a fragment of a name, because a tag nobody
 * can spell in full is the normal case. And an empty result has to say which of two very different things
 * it means — the tag does not exist, or it exists and has no notes in the requested scope — because a
 * silent `[]` is exactly what makes a tag search feel broken.
 */
function vault(options: { tagDocuments?: number; reads?: string[]; throws?: string } = {}): VaultClient {
  return {
    documents: {
      async get(key: string) { options.reads?.push(key); return null; },
      async list() { return { items: [], objects: [], cursor: null, truncated: false }; },
    } as unknown as VaultClient["documents"],
    index: {
      async query(kind: string) {
        if (options.throws) throw new Error(options.throws);
        const meta = { documents: 391, staleDocuments: 0, partial: false, indexReady: true, indexVersion: 1 };
        if (kind === "tags") return { ...meta, source: "index", tags: [{ tag: "跑步", referenceCount: 19 }, { tag: "日记", referenceCount: 40 }] };
        if (kind === "tag-documents") return { ...meta, source: "index", documents: Array.from({ length: options.tagDocuments ?? 1 }, () => ({ key: "daily/a.md" })) };
        return { ...meta, source: "index" };
      },
      async refresh() { return {}; },
    },
  } as unknown as VaultClient;
}

async function callTag(options: Parameters<typeof vault>[0], name: string, args: Record<string, unknown>) {
  const reads: string[] = [];
  const server = new McpServer({ name: "tag-test", version: "1.0.0" });
  registerTagTools({ server, env: { vault: vault({ ...options, reads }) } as unknown as Env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError ?? false, text: (result.content as Array<{ text: string }>).map(part => part.text ?? "").join("\n"), reads };
  } finally {
    await client.close();
  }
}

describe("listing tags", () => {
  it("answers from the index and never reads a document", async () => {
    const result = await callTag({}, "tag_list", {});

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).tags.map((item: { tag: string }) => item.tag)).toEqual(["跑步", "日记"]);
    expect(result.reads).toEqual([]);
  });

  it("passes the filters a caller chose through to the index", async () => {
    // The fake echoes nothing, so what is asserted is that the call is answered rather than refused — and
    // `contains` is the one that matters, because a prefix cannot find a name whose first character was
    // forgotten.
    const result = await callTag({}, "tag_list", { contains: "步", prefix: "跑", sources: ["frontmatter"], minReferences: 2, limit: 5 });
    expect(result.isError).toBe(false);
    expect(result.reads).toEqual([]);
  });
});

describe("an empty tag result says which kind of empty it is", () => {
  it("distinguishes a tag that does not exist from one with no notes in scope", async () => {
    // Half-remembered tag names are the normal case, so `步` has to come back with a suggestion.
    const missing = await callTag({ tagDocuments: 0 }, "tag_list_documents", { tag: "步" });
    expect(missing.isError).toBe(false);
    const report = JSON.parse(missing.text) as { tagExists: boolean; suggestions: string[]; note: string };
    expect(report.tagExists).toBe(false);
    expect(report.suggestions).toEqual(["跑步"]);
    expect(report.note).toContain("不在索引中");
    expect(missing.reads).toEqual([]);
  });

  it("says so when the tag exists but holds nothing in the requested scope", async () => {
    const scoped = await callTag({ tagDocuments: 0 }, "tag_list_documents", { tag: "跑步" });
    expect(scoped.isError).toBe(false);
    const report = JSON.parse(scoped.text) as { tagExists: boolean; note: string };
    expect(report.tagExists).toBe(true);
    expect(report.note).toContain("没有笔记");
  });

  it("returns the documents when the tag does have some", async () => {
    const found = await callTag({}, "tag_list_documents", { tag: "#跑步" });
    expect(found.isError).toBe(false);
    expect(JSON.parse(found.text)).toMatchObject({ source: "index", documents: [{ key: "daily/a.md" }] });
  });
});

describe("a tag query on an index that cannot answer", () => {
  it("reports the failure rather than an empty list", async () => {
    const result = await callTag({ throws: "no such table: document_tags" }, "tag_list", {});

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ error: "index_unavailable", detail: expect.stringContaining("document_tags") });
    expect(result.reads).toEqual([]);
  });
});
