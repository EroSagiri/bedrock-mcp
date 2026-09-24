import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerSearchTools } from "../apps/mcp/src/mcp/tools/search";
import type { VaultClient } from "../apps/mcp/src/vault-client";
import type { Env } from "../apps/mcp/src/types";

/**
 * A query is answered by the index, and by nothing else.
 *
 * Three rules are pinned here, and they are the whole point of removing the mode parameter. A search must
 * not read a single document — that is what having an index means, and it must hold on any vault size. A
 * search must never fall back to walking the vault, however the index answers. And an index that cannot
 * answer has to say so, because "no results" and "I could not look" are different answers.
 */
type IndexBehaviour = {
  documents?: number;
  stale?: number;
  indexReady?: boolean;
  throws?: string;
  results?: Array<Record<string, unknown>>;
  hits?: Array<Record<string, unknown>>;
  tags?: Array<{ tag: string }>;
};

function vault(options: IndexBehaviour, reads: string[]): VaultClient {
  return {
    documents: {
      async get(key: string) { reads.push(key); return null; },
      async metadata() { return null; },
      async head() { return null; },
      async list() { return { items: [], objects: [], cursor: null, truncated: false }; },
      async put() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
      async backupText() { throw new Error("not used"); },
      async move() { throw new Error("not used"); },
    } as unknown as VaultClient["documents"],
    index: {
      async query(kind: string) {
        if (options.throws) throw new Error(options.throws);
        const meta = {
          documents: options.documents ?? 1,
          staleDocuments: options.stale ?? 0,
          partial: (options.stale ?? 0) > 0,
          indexReady: options.indexReady ?? true,
          indexVersion: 1,
          lastAuditAt: options.indexReady === false ? null : "2026-01-01T00:00:00.000Z",
        };
        if (kind === "search") return { ...meta, source: "index", results: options.results ?? [] };
        if (kind === "filename-search") return { ...meta, source: "index", hits: options.hits ?? [] };
        if (kind === "tags") return { ...meta, source: "index", tags: options.tags ?? [] };
        return { ...meta, source: "index" };
      },
      async refresh() { return {}; },
    },
    async recordCommittedMutation() { return null; },
    pendingMutations: () => [],
    async flushOutstanding() {},
  } as unknown as VaultClient;
}

async function callTool(options: IndexBehaviour, args: Record<string, unknown>, tool = "search_text") {
  const reads: string[] = [];
  const server = new McpServer({ name: "search-test", version: "1.0.0" });
  registerSearchTools({ server, env: { vault: vault(options, reads) } as unknown as Env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return { isError: result.isError ?? false, text: (result.content as Array<{ text: string }>).map(part => part.text ?? "").join("\n"), reads };
  } finally {
    await client.close();
  }
}

describe("a content search never reads a document", () => {
  it("answers from the index on any vault size", async () => {
    const result = await callTool({ documents: 100_000, results: [{ key: "notes/a.md", snippet: "mineral" }] }, { query: "mineral" });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ query: "mineral", source: "index" });
    expect(result.reads).toEqual([]);
  });

  it("marks a search incomplete while documents are still unindexed", async () => {
    const result = await callTool({ documents: 390, stale: 40 }, { query: "Mineral" });
    const body = JSON.parse(result.text) as { partial: boolean; staleDocuments: number; note?: string };

    expect(body.partial).toBe(true);
    expect(body.staleDocuments).toBe(40);
    expect(body.note).toContain("40");
    // The remedy names the tool that catches the index up, rather than a scan that would paper over it.
    expect(body.note).toContain("vault_index_refresh");
  });

  it("reports a complete answer once nothing is stale", async () => {
    const result = await callTool({ documents: 390, stale: 0 }, { query: "Mineral" });
    const body = JSON.parse(result.text) as { partial: boolean; staleDocuments: number; note?: string };

    expect(body.partial).toBe(false);
    expect(body.staleDocuments).toBe(0);
    expect(body.note).toBeUndefined();
  });

  it("does not expose a retrieval mode", async () => {
    const reads: string[] = [];
    const server = new McpServer({ name: "search-test", version: "1.0.0" });
    registerSearchTools({ server, env: { vault: vault({}, reads) } as unknown as Env });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        expect(properties, tool.name).not.toContain("readMode");
      }
      // The fields a caller does choose are all still there.
      const searchText = listed.tools.find(tool => tool.name === "search_text")!;
      expect(Object.keys((searchText.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["limit", "prefix", "query", "searchIn"]);
    } finally {
      await client.close();
    }
  });
});

describe("an index that cannot answer says so", () => {
  it("reports an index that has never been built, and points at the audit", async () => {
    const result = await callTool({ indexReady: false, documents: 0 }, { query: "mineral" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; documents: number; remedies: string[] };
    expect(report.error).toBe("index_not_ready");
    expect(report.documents).toBe(0);
    expect(report.remedies.join(" ")).toContain("vault_index_refresh");
    // Not one document was read on the way to that answer.
    expect(result.reads).toEqual([]);
  });

  it("reports an index that threw, with what it said", async () => {
    const result = await callTool({ throws: "no such table: documents_fts" }, { query: "mineral" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; detail: string; remedies: string[] };
    expect(report.error).toBe("index_unavailable");
    expect(report.detail).toContain("documents_fts");
    expect(report.remedies.join(" ")).toContain("vault_index_refresh");
    expect(result.reads).toEqual([]);
  });

  it("refuses the removed live mode by name instead of answering a different question", async () => {
    const result = await callTool({ results: [{ key: "notes/a.md" }] }, { query: "mineral", readMode: "live" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; remedies: string[] };
    expect(report.error).toBe("live_mode_removed");
    expect(report.remedies.join(" ")).toContain("doc_read");
    expect(result.reads).toEqual([]);
  });

  it("accepts and ignores a cached readMode:\"index\"", async () => {
    const result = await callTool({ results: [{ key: "notes/a.md", snippet: "mineral" }] }, { query: "mineral", readMode: "index" });

    // The value named the only behaviour that was ever correct, so a client that cached it keeps working.
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ source: "index" });
    expect(result.reads).toEqual([]);
  });

  it("refuses a removed mode on every tool, not just the search", async () => {
    for (const tool of ["search_frontmatter", "tag_list", "tag_list_documents", "graph_get", "link_find_backlinks"]) {
      const body = tool === "tag_list_documents" || tool === "link_find_backlinks" ? { key: "a.md", tag: "跑步" } : { field: "tags" };
      const result = await callFor(tool, { ...body, readMode: "live" });
      expect(JSON.parse(result.text), tool).toMatchObject({ error: "live_mode_removed" });
      expect(result.reads, tool).toEqual([]);
    }
  });
});

/**
 * The same guard over every tool that had the parameter, registered together.
 *
 * It is one test rather than one per tool because the guard lives in the registration seam: if it holds
 * for a query tool it holds for all of them, and what would break it is a tool registering its schemas a
 * different way.
 */
async function callFor(tool: string, args: Record<string, unknown>) {
  const reads: string[] = [];
  const server = new McpServer({ name: "guard-test", version: "1.0.0" });
  const { registerVaultTools } = await import("../apps/mcp/src/mcp/tools/vault");
  const { registerTagTools } = await import("../apps/mcp/src/mcp/tools/tags");
  const { registerGraphTools } = await import("../apps/mcp/src/mcp/tools/graph");
  const { registerLinkTools } = await import("../apps/mcp/src/mcp/tools/links");
  const ctx = { server, env: { vault: vault({}, reads) } as unknown as Env };
  registerSearchTools(ctx);
  registerVaultTools(ctx);
  registerTagTools(ctx);
  registerGraphTools(ctx);
  registerLinkTools(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return { isError: result.isError ?? false, text: (result.content as Array<{ text: string }>).map(part => part.text ?? "").join("\n"), reads };
  } finally {
    await client.close();
  }
}

describe("a default content search also finds a note by name", () => {
  it("merges the filename projection, and keeps both signals on one hit", async () => {
    const result = await callTool({
      results: [{ key: "notes/body.md", snippet: "mineral" }, { key: "notes/mineral-plan.md", snippet: "mineral" }],
      hits: [{ key: "notes/mineral-plan.md", modified: "2026-01-01T00:00:00.000Z", size: 10 }, { key: "notes/old-mineral.md", modified: "2026-01-01T00:00:00.000Z", size: 10 }],
    }, { query: "mineral" });
    const body = JSON.parse(result.text) as { results: Array<{ key: string; matched: string[]; nameQuality?: string }>; nameMatches: number };

    expect(body.nameMatches).toBe(2);
    expect(body.results.find(hit => hit.key === "notes/mineral-plan.md")).toMatchObject({ matched: ["name", "content"], nameQuality: "prefix" });
    expect(body.results.find(hit => hit.key === "notes/old-mineral.md")).toMatchObject({ matched: ["name"], nameQuality: "substring" });
    expect(body.results.find(hit => hit.key === "notes/body.md")).toMatchObject({ matched: ["content"] });
    // The document that carries both signals is one entry, not two.
    expect(new Set(body.results.map(hit => hit.key)).size).toBe(body.results.length);
    expect(result.reads).toEqual([]);
  });

  it("boosts a strong filename hit above a phrase buried in a body", async () => {
    const result = await callTool({
      results: [{ key: "daily/2026-01-02.md", snippet: "…提到 2026-06 一次…" }, { key: "daily/2026-05-01.md", snippet: "…也提到 2026-06…" }],
      hits: [{ key: "daily/2026-06-18.md", modified: "2026-01-01T00:00:00.000Z", size: 10 }],
    }, { query: "2026-06" });
    const body = JSON.parse(result.text) as { results: Array<{ key: string; matched: string[] }>; ranking: string };

    // The note whose *name* is the date wins, which is the answer a caller asking "2026-06" expects.
    expect(body.results[0]).toMatchObject({ key: "daily/2026-06-18.md", matched: ["name"] });
    // But the content hits are not displaced wholesale: they follow, in the index's own order.
    expect(body.results.slice(1).map(hit => hit.key)).toEqual(["daily/2026-01-02.md", "daily/2026-05-01.md"]);
  });

  it("does not lift a weak filename hit above the full-text ranking", async () => {
    const result = await callTool({
      results: [{ key: "notes/body.md", snippet: "mineral" }],
      hits: [{ key: "mineral/notes/other.md", modified: "2026-01-01T00:00:00.000Z", size: 10 }],
    }, { query: "mineral" });
    const body = JSON.parse(result.text) as { results: Array<{ key: string; matched: string[]; nameQuality?: string }> };

    // The query is only in the *directory*, so it is reported and ranked after the content hit.
    expect(body.results.map(hit => hit.key)).toEqual(["notes/body.md", "mineral/notes/other.md"]);
    expect(body.results[1]).toMatchObject({ matched: ["name"], nameQuality: "path" });
  });

  it("asks only for the fields the caller chose", async () => {
    const namesOnly = await callTool({ hits: [{ key: "notes/mineral.md" }] }, { query: "mineral", searchIn: ["filename"] });
    const namesBody = JSON.parse(namesOnly.text) as { searchIn: string[]; ranking: string; results: Array<{ matched: string[]; nameQuality?: string }> };
    expect(namesBody.searchIn).toEqual(["filename"]);
    expect(namesBody.ranking).toBe("name");
    // With no content signal to weigh against, a note named exactly this is simply the answer.
    expect(namesBody.results).toEqual([expect.objectContaining({ matched: ["name"], nameQuality: "exact" })]);

    const contentOnly = await callTool({ results: [{ key: "notes/a.md" }], hits: [{ key: "notes/b.md" }] }, { query: "mineral", searchIn: ["content"] });
    const contentBody = JSON.parse(contentOnly.text) as { searchIn: string[]; results: Array<{ key: string; matched: string[] }> };
    expect(contentBody.searchIn).toEqual(["content"]);
    expect(contentBody.results.map(hit => hit.key)).toEqual(["notes/a.md"]);
    expect(contentOnly.reads).toEqual([]);
  });
});
