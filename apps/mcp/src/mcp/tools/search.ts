import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { readIndex } from "../index-client";
import { err, ok, type McpRegistrationContext } from "../shared";

/**
 * The two searches, and the line between them.
 *
 * `search_text` is the note index: exact, immediate, and answered entirely inside SQLite. `search_semantic`
 * is the vector index: by meaning, eventually consistent. Neither reads a document, and neither falls back
 * to walking the vault — a query is a retrieval question, and retrieval is what the indexes are for. The
 * only tool that reads R2 is the one whose job is to read a document.
 */

/** The exact shape the index's `search` kind returns, as far as this tool reads it. */
type ContentSearchResult = {
  results?: Array<Record<string, unknown> & { key?: string }>;
  partial?: boolean;
  staleDocuments?: number;
};

/** The Vault has no vector binding, which is a deployment fact and not a failed search. */
function semanticUnavailable(): CallToolResult {
  return err(JSON.stringify({
    error: "vector_index_unavailable",
    detail: "此 Vault 没有可用的向量索引，无法按语义检索。",
    remedies: [
      "用 search_text 做全文检索：中文按子串匹配，词在句子里也能找到",
      "如果用 search_semantic 返回 index_unavailable，那是索引故障，用 vault_index_refresh 触发审计",
    ],
  }, null, 2));
}

export function registerSearchTools(ctx: McpRegistrationContext): void {
    /**
     * Search by meaning, as a tool of its own.
     *
     * It is deliberately not a mode of `search_text`. Full text can only miss a document; a vector search
     * can also return a passage that no longer describes the note, so the two have genuinely different
     * failure modes, and a caller that cannot tell them apart cannot tell a bad answer from an absent
     * one. The result carries `filteredCandidates` for the same reason: hits the index offered and the
     * Vault refused are not the same thing as hits that were never there.
     */
    registerToolCompat(ctx.server,
      "search_semantic",
      {
        inputSchema: {
          query: z.string().min(1).describe("自然语言查询；按语义而非字面匹配"),
          limit: z.number().int().min(1).max(50).optional(),
          prefix: z.string().optional().describe("只在该路径前缀内检索，例如 'daily/'"),
        },
      },
      async ({ query, limit, prefix }) => {
        const result = await ctx.env.vault.searchSemantic({ query, limit, prefix });
        if (!result) return semanticUnavailable();
        if (result.error) return err(JSON.stringify(result, null, 2));
        return ok(JSON.stringify(result, null, 2));
      }
    );

    // 全文检索：索引回答，不读 R2
    registerToolCompat(ctx.server,
      "search_text",
      {
        inputSchema: {
          query: z.string().min(1).describe("检索词。中文按子串匹配（词在句子里也能找到），拉丁词走倒排索引并按相关度排序"),
          searchIn: z.array(z.enum(["content", "filename", "path"]))
            .optional()
            .describe("搜索范围，默认 ['content','filename']。searchIn 只表示搜索字段，不表示检索方式：三者都由索引回答，都不读 R2。frontmatter 请用 search_frontmatter"),
          prefix: z.string().optional().describe("限定目录，例如 'daily/'，由索引在 SQL 中过滤"),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async ({ query, searchIn, prefix, limit }) => {
        const fields = new Set(searchIn ?? ["content", "filename"]);
        const max = limit ?? 20;

        // The default is content *and* filename, and they are two indexed queries rather than one: a note
        // found by name must not be missing from a default search just because its body does not contain
        // the word. Each hit says which of the two found it.
        let content: ContentSearchResult = {};
        if (fields.has("content")) {
          const outcome = await readIndex<ContentSearchResult>(ctx.env, "search", { query, prefix, limit: max });
          if (!outcome.ok) return outcome.result;
          content = outcome.data;
        }

        const results: Array<Record<string, unknown>> = (content.results ?? []).map(result => ({ ...result, matched: "content" }));
        if (fields.has("filename") || fields.has("path")) {
          const outcome = await readIndex<{ hits?: Array<{ key: string }> }>(ctx.env, "filename-search", { query, prefix, limit: max });
          if (!outcome.ok) return outcome.result;
          const known = new Set(results.map(result => result.key));
          for (const hit of outcome.data.hits ?? []) {
            if (hit.key && !known.has(hit.key)) results.push({ ...hit, matched: "name" });
          }
        }

        return ok(JSON.stringify({
          ...content,
          results: results.slice(0, max),
          nameMatches: results.filter(result => result.matched === "name").length,
          query,
          searchIn: [...fields],
          source: "index",
          // A search answered while documents are still unindexed is not a complete answer, and saying so
          // is the difference between "not found" and "not known yet".
          ...(content.partial ? { note: `索引回填中：${content.staleDocuments ?? "?"} 篇尚未索引，本次结果可能不完整。用 vault_index_refresh 可以立刻推进。` } : {}),
        }, null, 2));
      }
    );

    // 按 frontmatter 字段值过滤
    registerToolCompat(ctx.server,
      "search_frontmatter",
      {
        inputSchema: {
          field: z.string().min(1).describe("frontmatter 字段名，例如 'status'；标签在 'tags' 里"),
          value: z.string().optional().describe("精确匹配的值；不传则返回所有有该字段的笔记"),
          contains: z.string().optional().describe("子串匹配（与 value 二选一）"),
          prefix: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async ({ field, value, contains, prefix, limit }) => {
        const outcome = await readIndex(ctx.env, "frontmatter", { field, value, contains, prefix, limit });
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );
}
