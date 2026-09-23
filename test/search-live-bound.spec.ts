import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { MAX_LIVE_SCAN_DOCUMENTS, registerSearchTools } from "../apps/mcp/src/mcp/tools/search";
import type { VaultClient } from "../apps/mcp/src/vault-client";
import type { Env } from "../apps/mcp/src/types";

/**
 * Where a content search is answered, and what it says when it cannot answer fully.
 *
 * Two rules are pinned here. A content search in index mode must be answered by the index and must not
 * read a single document - that is the whole point of having a full-text index instead of a scan. And a
 * live scan, whose cost is one read per document, must refuse a vault it cannot afford rather than be
 * killed mid-walk by the runtime.
 */
function vault(options: { documents: number; reads: string[]; stale?: number }): VaultClient {
  return {
    documents: {
      async get(key: string) { options.reads.push(key); return null; },
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
        if (kind === "documents") return { documents: Array.from({ length: options.documents }, (_, index) => ({ key: `note-${index}.md` })) };
        if (kind === "folders") return { items: [{ folder: "templates", count: 3 }, { folder: "(root)", count: 4 }] };
        if (kind === "search") return { results: [{ key: "note-1.md", snippet: "mineral" }], staleDocuments: options.stale ?? 0, partial: (options.stale ?? 0) > 0 };
        return {};
      },
      async refresh() { return {}; },
    },
    async recordCommittedMutation() { return null; },
    pendingMutations: () => [],
    async flushOutstanding() {},
  } as unknown as VaultClient;
}

async function callTool(options: { documents: number; stale?: number }, args: Record<string, unknown>) {
  const reads: string[] = [];
  const server = new McpServer({ name: "search-test", version: "1.0.0" });
  registerSearchTools({ server, env: { vault: vault({ ...options, reads }) } as unknown as Env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "search_text", arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map(part => part.text ?? "").join("\n");
    return { isError: result.isError ?? false, text, reads };
  } finally {
    await client.close();
  }
}

describe("content search is answered by the index", () => {
  it("returns index hits without reading a single document, on any vault size", async () => {
    const result = await callTool({ documents: MAX_LIVE_SCAN_DOCUMENTS + 5000 }, { query: "mineral" });

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
  });

  it("reports a complete answer once nothing is stale", async () => {
    const result = await callTool({ documents: 390, stale: 0 }, { query: "Mineral" });
    const body = JSON.parse(result.text) as { partial: boolean; staleDocuments: number; note?: string };

    expect(body.partial).toBe(false);
    expect(body.staleDocuments).toBe(0);
    expect(body.note).toBeUndefined();
  });
});

describe("a live scan is still bounded", () => {
  it("refuses a vault past the bound without reading a single document", async () => {
    const result = await callTool({ documents: MAX_LIVE_SCAN_DOCUMENTS + 1 }, { query: "mineral", readMode: "live" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; documents: number; limit: number; remedies: string[] };
    expect(report.error).toBe("vault_too_large_for_live_content_search");
    expect(report.documents).toBe(MAX_LIVE_SCAN_DOCUMENTS + 1);
    expect(report.limit).toBe(MAX_LIVE_SCAN_DOCUMENTS);
    expect(report.remedies.join(" ")).toContain("prefix");
    expect(result.reads).toEqual([]);
  });

  it("runs a live scan on a vault within the bound", async () => {
    const result = await callTool({ documents: MAX_LIVE_SCAN_DOCUMENTS }, { query: "mineral", readMode: "live" });
    expect(result.text).toContain('"query": "mineral"');
  });
});
