import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { readIndex } from "../index-client";
import { matchSignals, nameMatchQuality, type NameQuality } from "../name-match";
import { err, ok, type McpRegistrationContext } from "../shared";

/**
 * The two searches, and the line between them.
 *
 * `search_text` is the note index: exact, immediate, and answered entirely inside SQLite. `search_semantic`
 * is the vector index: by meaning, eventually consistent. Neither reads a document, and neither falls back
 * to walking the vault — a query is a retrieval question, and retrieval is what the indexes are for. The
 * only tool that reads R2 is the one whose job is to read a document.
 *
 * `search_text` deliberately searches **content and filename** by default. It is "find me the thing" more
 * than it is a regex over bodies, and the clue a caller remembers is often the note's name — a date, a
 * title fragment. Returning nothing because `2026-06` lives in `daily/2026-06-18.md` rather than in a
 * paragraph would be the surprising answer. `searchIn` narrows it when exactness is what is wanted.
 */

/** The exact shape the index's `search` kind returns, as far as this tool reads it. */
type ContentSearchResult = {
  results?: Array<Record<string, unknown> & { key?: string }>;
  partial?: boolean;
  staleDocuments?: number;
  /** Which ranking answered the content half: `bm25` for Latin terms, `phrase` for CJK substrings. */
  ranking?: string;
};

type MergedHit = Record<string, unknown> & { key: string; matched: string[]; nameQuality?: NameQuality; tier: number; order: number };

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
            .describe("搜索范围，默认 ['content','filename']。它只表示搜索字段，不表示检索方式：三者都由索引回答，都不读 R2。默认同时查正文和文件名，因为用户记住的线索常常就是文件名（日期、标题片段）；要精确全文检索传 ['content']，要导航型检索传 ['filename']。frontmatter 请用 search_frontmatter"),
          prefix: z.string().optional().describe("限定目录，例如 'daily/'，由索引在 SQL 中过滤"),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async ({ query, searchIn, prefix, limit }) => {
        const fields = new Set(searchIn ?? ["content", "filename"]);
        const max = limit ?? 20;

        // The two signals are collected separately and merged once, because a document can carry both and
        // must then come back once — with both signals reported, not with one of them thrown away.
        let content: ContentSearchResult = {};
        if (fields.has("content")) {
          const outcome = await readIndex<ContentSearchResult>(ctx.env, "search", { query, prefix, limit: max });
          if (!outcome.ok) return outcome.result;
          content = outcome.data;
        }

        const hits = new Map<string, MergedHit>();
        let order = 0;
        for (const result of content.results ?? []) {
          if (!result.key) continue;
          hits.set(result.key, { ...result, key: result.key, matched: ["content"], tier: 0, order: order++ });
        }
        if (fields.has("filename") || fields.has("path")) {
          const outcome = await readIndex<{ hits?: Array<{ key: string }> }>(ctx.env, "filename-search", { query, prefix, limit: max });
          if (!outcome.ok) return outcome.result;
          for (const hit of outcome.data.hits ?? []) {
            if (!hit.key) continue;
            // `filename-search` matched the key, so a null here would mean the two disagree about what
            // "contains" means. Grading it as a path match keeps the hit — and says what it is worth —
            // rather than dropping a document the index just found.
            const quality = nameMatchQuality(hit.key, query) ?? "path";
            const existing = hits.get(hit.key);
            if (existing) existing.nameQuality = quality;
            else hits.set(hit.key, { ...hit, matched: ["name"], nameQuality: quality, tier: 0, order: order++ });
          }
        }

        // A document is ranked by its *strongest* signal: an exact filename match stays an exact filename
        // match even when its body also happens to contain the query.
        const merged = [...hits.values()].map(hit => {
          const { tier, matched } = matchSignals({ name: hit.nameQuality ?? null, content: hit.matched.includes("content") });
          return { ...hit, tier, matched };
        });
        // Tier first — a strong name match outranks a phrase in a paragraph — then the index's own order
        // within a tier, which is bm25 or the phrase ranking for content and recency for names.
        merged.sort((left, right) => left.tier - right.tier || left.order - right.order);

        return ok(JSON.stringify({
          ...content,
          results: merged.slice(0, max).map(({ tier, order: _order, ...hit }) => ({ ...hit, tier })),
          nameMatches: merged.filter(hit => hit.matched.includes("name")).length,
          query,
          searchIn: [...fields],
          source: "index",
          ranking: fields.has("content") ? content.ranking ?? "bm25" : "name",
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
