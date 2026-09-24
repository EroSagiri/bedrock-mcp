import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerTagTools } from "../apps/mcp/src/mcp/tools/tags";
import { registerSearchTools } from "../apps/mcp/src/mcp/tools/search";
import { MAX_LIVE_SCAN_DOCUMENTS } from "../apps/mcp/src/mcp/live-scan";
import type { Env } from "../apps/mcp/src/types";
import type { VaultClient } from "../apps/mcp/src/vault-client";

/**
 * A live tag scan is a live content scan.
 *
 * It reads one document per candidate through the Vault RPC, so on a vault past the subrequest ceiling the
 * runtime kills it with "Too many subrequests by single Worker invocation" — which is what the deployed
 * vault was doing for `tag_list` before this bound existed. The tags are in the index, so the live path is
 * never the answer a caller wants; what it must not be is a hard, unexplained failure.
 */
function vault(documents: number, reads: string[], options: { tagDocuments?: number } = {}): VaultClient {
  const tagDocuments = options.tagDocuments ?? 1;
  return {
    documents: {
      async get(key: string) { reads.push(key); return null; },
      async list() { return { items: [], objects: [], cursor: null, truncated: false }; },
    } as unknown as VaultClient["documents"],
    index: {
      async query(kind: string) {
        if (kind === "documents") return { documents: Array.from({ length: documents }, (_, index) => ({ key: `note-${index}.md` })) };
        if (kind === "folders") return { items: [{ folder: "daily", count: 12 }] };
        if (kind === "tags") return { source: "index", tags: [{ tag: "跑步", referenceCount: 19 }, { tag: "日记", referenceCount: 40 }] };
        if (kind === "tag-documents") return { source: "index", documents: Array.from({ length: tagDocuments }, () => ({ key: "daily/a.md" })) };
        if (kind === "frontmatter") return { source: "index", matches: [{ key: "daily/a.md" }] };
        return {};
      },
      async refresh() { return {}; },
    },
  } as unknown as VaultClient;
}

async function call(register: (ctx: { server: McpServer; env: Env }) => void, documents: number, name: string, args: Record<string, unknown>, options: { tagDocuments?: number } = {}) {
  const reads: string[] = [];
  const server = new McpServer({ name: "tag-test", version: "1.0.0" });
  register({ server, env: { vault: vault(documents, reads, options) } as unknown as Env });
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

const callTag = (documents: number, name: string, args: Record<string, unknown>, options: { tagDocuments?: number } = {}) => call(registerTagTools, documents, name, args, options);

describe("an empty tag result says which kind of empty it is", () => {
  it("distinguishes a tag that does not exist from one with no notes in scope", async () => {
    // Half-remembered tag names are the normal case, so `步` has to come back with a suggestion.
    const missing = await callTag(1, "tag_list_documents", { tag: "步" }, { tagDocuments: 0 });
    expect(missing.isError).toBe(false);
    const report = JSON.parse(missing.text) as { tagExists: boolean; suggestions: string[]; note: string };
    expect(report.tagExists).toBe(false);
    expect(report.suggestions).toEqual(["跑步"]);
    expect(report.note).toContain("不在索引中");
  });

  it("says so when the tag exists but holds nothing in the requested scope", async () => {
    const scoped = await callTag(1, "tag_list_documents", { tag: "跑步" }, { tagDocuments: 0 });
    expect(scoped.isError).toBe(false);
    const report = JSON.parse(scoped.text) as { tagExists: boolean; note: string };
    // No documents came back, so this is the other empty case — and the two are not the same answer.
    expect(report.tagExists).toBe(true);
    expect(report.note).toContain("没有笔记");
  });
});

describe("live tag scans are bounded", () => {
  it("refuses tag_list on a vault past the bound, without reading a document", async () => {
    const result = await callTag(MAX_LIVE_SCAN_DOCUMENTS + 1, "tag_list", { readMode: "live" });

    expect(result.isError).toBe(true);
    const report = JSON.parse(result.text) as { error: string; operation: string; documents: number; remedies: string[] };
    expect(report.error).toBe("vault_too_large_for_live_scan");
    expect(report.operation).toContain("tag_list");
    expect(report.documents).toBe(MAX_LIVE_SCAN_DOCUMENTS + 1);
    expect(report.remedies.join(" ")).toContain("index");
    expect(result.reads).toEqual([]);
  });

  it("refuses tag_list_documents on a vault past the bound", async () => {
    const result = await callTag(MAX_LIVE_SCAN_DOCUMENTS + 1, "tag_list_documents", { tag: "跑步", readMode: "live" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ error: "vault_too_large_for_live_scan", operation: "tag_list_documents live scan" });
    expect(result.reads).toEqual([]);
  });

  it("answers the same question from the index, on any vault size", async () => {
    const listed = await callTag(MAX_LIVE_SCAN_DOCUMENTS + 5000, "tag_list", {});
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.text).tags.map((item: { tag: string }) => item.tag)).toEqual(["跑步", "日记"]);

    const documents = await callTag(MAX_LIVE_SCAN_DOCUMENTS + 5000, "tag_list_documents", { tag: "#跑步" });
    expect(documents.isError).toBe(false);
    // `#跑步` is the same tag as `跑步`: the leading hash is a way of writing it, not part of its name.
    expect(JSON.parse(documents.text)).toMatchObject({ source: "index", documents: [{ key: "daily/a.md" }] });
    expect(listed.reads).toEqual([]);
    expect(documents.reads).toEqual([]);
  });

  it("refuses a live frontmatter scan too, which fails the same way", async () => {
    const result = await call(registerSearchTools, MAX_LIVE_SCAN_DOCUMENTS + 1, "search_frontmatter", { field: "tags", contains: "跑", readMode: "live" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ error: "vault_too_large_for_live_scan", operation: "search_frontmatter live scan" });
    expect(result.reads).toEqual([]);
  });
});
