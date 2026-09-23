import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { MAX_LIVE_SCAN_DOCUMENTS, registerSearchTools } from "../apps/mcp/src/mcp/tools/search";
import type { VaultClient } from "../apps/mcp/src/vault-client";
import type { Env } from "../apps/mcp/src/types";

/**
 * A live content search reads one document per RPC call, so the vault's size *is* the subrequest count
 * and a Worker has a hard ceiling on those. Past it the runtime kills the invocation with "Too many
 * subrequests by single Worker invocation" - an error that names neither the cause nor the remedy.
 *
 * This drives the registered tool itself, so it fails if the guard stops running before the scan, and
 * it fails if the refusal stops telling the caller what to do.
 */
function vault(documents: number, reads: string[]): VaultClient {
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
        // The guard asks the index how many documents a scan with this prefix would walk. The list is
        // the same projection every indexed query uses, so it is synthesised from the size the test
        // asked for; `stats` is here for the other tools that read it.
        if (kind === "documents") return { documents: Array.from({ length: documents }, (_, index) => ({ key: `note-${index}.md` })) };
        if (kind === "stats") return { total: { count: documents, sizeBytes: documents * 100 } };
        if (kind === "filename-search") return { hits: [] };
        if (kind === "folders") return { items: [{ folder: "templates", count: 3 }, { folder: "(root)", count: 4 }] };
        return {};
      },
      async refresh() { return {}; },
    },
    async recordCommittedMutation() { return null; },
    pendingMutations: () => [],
    async flushOutstanding() {},
  } as unknown as VaultClient;
}

async function callTool(documents: number, reads: string[], args: Record<string, unknown>) {
  const server = new McpServer({ name: "search-bound-test", version: "1.0.0" });
  registerSearchTools({ server, env: { vault: vault(documents, reads) } as unknown as Env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "search_text", arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map(part => part.text ?? "").join("\n");
    return { isError: result.isError ?? false, text };
  } finally {
    await client.close();
  }
}

describe("search_text refuses a live content scan it cannot afford", () => {
  it("refuses a vault past the bound without reading a single document", async () => {
    const reads: string[] = [];
    const result = await callTool(MAX_LIVE_SCAN_DOCUMENTS + 1, reads, { query: "mineral" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; documents: number; limit: number; remedies: string[] };
    expect(report.error).toBe("vault_too_large_for_live_content_search");
    expect(report.documents).toBe(MAX_LIVE_SCAN_DOCUMENTS + 1);
    expect(report.limit).toBe(MAX_LIVE_SCAN_DOCUMENTS);
    // The remedy is the point of refusing: a prefix, the index, or a tag query.
    expect(report.remedies.join(" ")).toContain("prefix");
    // The refusal happens *before* the scan, which is the whole reason the bound exists.
    expect(reads).toEqual([]);
  });

  it("still runs a content search on a vault within the bound", async () => {
    const reads: string[] = [];
    const result = await callTool(MAX_LIVE_SCAN_DOCUMENTS, reads, { query: "mineral" });

    // A small vault lists and reads; an empty listing is a legitimate no-match answer.
    expect(result.text).toContain('"query": "mineral"');
    expect(reads).toEqual([]);
  });

  it("never applies the content bound to an index-only filename search", async () => {
    const reads: string[] = [];
    const result = await callTool(MAX_LIVE_SCAN_DOCUMENTS + 5000, reads, { query: "index", searchIn: ["filename", "path"], readMode: "index" });

    // No content is read, so vault size is irrelevant: this path must keep working at any size.
    expect(result.isError).toBe(false);
    expect(reads).toEqual([]);
  });
});


