import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "@mineral/core/content";
import { backlinkTargets, scanTextFiles } from "../../vault-client";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { indexQuery, readModeSchemaDescription } from "../index-client";
import { MAX_LIVE_SCAN_DOCUMENTS, refuseLargeLiveScan } from "../live-scan";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

// Re-exported because it is part of the search tool's documented contract, and a caller that wants to
// explain the bound should not have to import the shared module to find it.
export { MAX_LIVE_SCAN_DOCUMENTS };

/** The exact shape `search` returns, as far as this tool reads it. */
type ContentSearchResult = {
  results?: Array<Record<string, unknown> & { key?: string }>;
  partial?: boolean;
  staleDocuments?: number;
};

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
        if (!result) return err("此 Vault 未配置向量索引，无法做语义检索");
        if (result.error) return err(JSON.stringify(result, null, 2));
        return ok(JSON.stringify(result, null, 2));
      }
    );

    // 全文检索（暴力扫描，适合小型 vault）
    registerToolCompat(ctx.server,
      "search_text",
      {
        query: z.string().min(1),
        regex: z.boolean().optional().describe("把 query 当正则（仅 live 模式支持）。例：'^# .*会议' 找'# 会议'开头的标题"),
        caseSensitive: z.boolean().optional().describe("区分大小写，默认 false（仅 live 模式支持）"),
        searchIn: z.array(z.enum(["content", "filename", "path", "frontmatter"]))
          .optional()
          .describe("搜索范围，默认 ['content','filename']。index 模式下 content 走 SQLite FTS5（不读 R2，快）；只有显式 readMode='live' 才逐篇实扫，且文档数超过 " + MAX_LIVE_SCAN_DOCUMENTS + " 会被拒绝。frontmatter 请用 search_frontmatter。"),
        prefix: z.string().optional().describe("限定目录，例如 'daily/'"),
        limit: z.number().int().min(1).max(200).optional(),
        contextChars: z.number().int().min(20).max(500).optional().describe("片段前后字符数，默认 60（仅 live 模式使用；index 模式由 FTS 生成片段）"),
        readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
      },
      async ({ query, regex, caseSensitive, searchIn, prefix, limit, contextChars, readMode }) => {
        const fields = new Set(searchIn ?? ["content", "filename"]);
        const snippetCtx = contextChars ?? 60;
        const max = limit ?? 20;
        const cs = caseSensitive ?? false;
        const mode = readMode ?? "index";

        // Full text is answered from the index, not from R2: the FTS row carries the body, so a hit and
        // its snippet come back from one SQLite query. Only an explicit `live` request walks the vault,
        // and that path is bounded because its cost is one read per document.
        if (mode === "index" && !regex && !cs && (fields.has("content") || (!fields.has("content") && !fields.has("frontmatter")))) {
          const content = await indexQuery(ctx.env, "search", { query, prefix, limit: max }) as ContentSearchResult;
          const results: Array<Record<string, unknown>> = (content.results ?? []).map(result => ({ ...result, matched: "content" }));
          // `searchIn` defaults to content *and* filename, and the content answer is a full-text one: a
          // note whose *name* matches would otherwise be missing from a default search, silently. The
          // name projection is a second indexed query, not a scan.
          if (fields.has("filename") || fields.has("path")) {
            const named = await indexQuery(ctx.env, "filename-search", { query, prefix, limit: max }) as { hits?: Array<{ key: string }> };
            const known = new Set(results.map(result => result.key));
            for (const hit of named.hits ?? []) {
              if (hit.key && !known.has(hit.key)) results.push({ ...hit, matched: "name" });
            }
          }
          return ok(JSON.stringify({
            ...content,
            results: results.slice(0, max),
            nameMatches: results.filter(result => result.matched === "name").length,
            query,
            source: "index",
            // A search answered while documents are still unindexed is not a complete answer, and
            // saying so is the difference between "not found" and "not known yet".
            ...(content.partial ? { note: `索引回填中：${content.staleDocuments ?? "?"} 篇尚未索引，本次结果可能不完整。` } : {}),
          }, null, 2));
        }

        // Filename/path only, no content: the metadata projection is enough.
        if (mode === "index" && !regex && !fields.has("content") && !fields.has("frontmatter")) {
          return ok(JSON.stringify(await indexQuery(ctx.env, "filename-search", { query, prefix, limit: limit ?? 20 }), null, 2));
        }

        const matcher = buildMatcher(query, regex ?? false, cs);
        if ("error" in matcher) return err(matcher.error);

        const needsContent = fields.has("content") || fields.has("frontmatter");

        // A live content scan costs one RPC per candidate document, so its size is the subrequest
        // count. The size that matters is the one the scan will actually walk — a `prefix` narrows it,
        // and refusing a bounded search because the whole vault is large would make the remedy useless.
        if (needsContent) {
          const refused = await refuseLargeLiveScan(ctx, {
            prefix,
            operation: "search_text content scan",
            indexRemedy: "改用 readMode='index'（默认）：内容走 SQLite 全文索引，不读 R2，且不受此上限限制",
          });
          if (refused) return refused;
        }

        type Hit = { in: string; field?: string; value?: string; snippet?: string };
        type FileResult = { key: string; modified: string; modifiedRelative: string; matches: Hit[] };
        const hits: FileResult[] = [];

        let cursor: string | undefined;
        scan: do {
          const r = await ctx.env.vault.documents.list({ prefix, cursor, limit: 1000 });
          // filename/path 可以匹配所有文件；content/tags/frontmatter 只查文本文件
          const candidates = needsContent
            ? r.objects.filter(o => isTextFile(o.key))
            : r.objects;

          const batchSize = 10;
          for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async o => {
              const matches: Hit[] = [];
              const basename = o.key.split("/").pop() ?? o.key;

              if (fields.has("filename") && matcher.match(basename)) {
                matches.push({ in: "filename", value: basename });
              }
              if (fields.has("path") && matcher.match(o.key)) {
                matches.push({ in: "path", value: o.key });
              }

              if (needsContent && isTextFile(o.key)) {
                const obj = await ctx.env.vault.documents.get(o.key);
                if (obj) {
                  const text = await obj.text();

                  if (fields.has("content")) {
                    const m = matcher.match(text);
                    if (m) matches.push({
                      in: "content",
                      snippet: snippetAt(text, m.index, m.length, snippetCtx),
                    });
                  }
                  if (fields.has("frontmatter")) {
                    const { frontmatter } = parseFrontmatter(text);
                    if (frontmatter) {
                      for (const [k, v] of Object.entries(frontmatter)) {
                        const normalized = typeof v === "string" ? v : JSON.stringify(v);
                        if (matcher.match(normalized) || matcher.match(k)) {
                          matches.push({ in: "frontmatter", field: k, value: normalized });
                          break;
                        }
                      }
                    }
                  }
                }
              }

              if (matches.length === 0) return null;
              return {
                key: o.key,
                modified: o.uploaded.toISOString(),
                modifiedRelative: relativeTime(o.uploaded),
                matches,
              } satisfies FileResult;
            }));

            for (const r of results) {
              if (r) hits.push(r);
              if (hits.length >= max) break scan;
            }
          }
          cursor = r.cursor ?? undefined;
        } while (cursor);

        hits.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({
          query,
          regex: !!regex,
          caseSensitive: cs,
          searchIn: [...fields],
          count: hits.length,
          hits,
          source: "live",
          freshness: "live",
        }, null, 2));
      }
    );
    // 按 frontmatter 字段值过滤
    registerToolCompat(ctx.server,
      "search_frontmatter",
      {
        field: z.string().min(1).describe("frontmatter 字段名，例如 'status'"),
        value: z.string().optional().describe("精确匹配的值；不传则返回所有有该字段的笔记"),
        contains: z.string().optional().describe("子串匹配（与 value 二选一）"),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
      },
      async ({ field, value, contains, prefix, limit, readMode }) => {
        if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "frontmatter", { field, value, contains, prefix, limit }), null, 2));
        const refused = await refuseLargeLiveScan(ctx, {
          prefix,
          operation: "search_frontmatter live scan",
          indexRemedy: "改用 readMode='index'（默认）：frontmatter 已进索引，结果相同且不读 R2",
        });
        if (refused) return refused;
        const matches = await scanTextFiles(ctx.env.vault.documents, prefix, (k, text, o) => {
          const { frontmatter } = parseFrontmatter(text);
          if (!frontmatter || !(field in frontmatter)) return null;
          const v = frontmatter[field];
          const rendered = typeof v === "string" ? v : JSON.stringify(v);
          if (value !== undefined && rendered !== value) return null;
          if (contains !== undefined && !rendered.toLowerCase().includes(contains.toLowerCase())) return null;
          return {
            key: k,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            value: rendered,
          };
        }, { max: limit ?? 100 });
        matches.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({ field, value, contains, count: matches.length, matches, source: "live", freshness: "live" }, null, 2));
      }
    );
}
