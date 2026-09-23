import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "@mineral/core/content";
import { backlinkTargets, scanTextFiles } from "../../vault-client";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { indexQuery, readModeSchemaDescription } from "../index-client";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

/**
 * The largest live content scan this tool will start.
 *
 * A live content search reads every candidate document through the Vault RPC, so the vault's size *is*
 * the subrequest count, and a Worker has a hard ceiling on those. Past it the runtime kills the
 * invocation mid-scan with "Too many subrequests by single Worker invocation" — an error that names
 * neither the cause nor the remedy, and that a vault crosses silently as it grows.
 *
 * So the size is checked first and refused with something actionable. The bound is deliberately
 * conservative: the ceiling itself depends on the account's plan, and a scan this tool refuses is one
 * `prefix` away from running.
 */
export const MAX_LIVE_SCAN_DOCUMENTS = 200;

/**
 * How many documents a live scan with this prefix would read.
 *
 * Answered from the index in one projection read — the Documents list is the same one every other
 * indexed query uses, so this costs a single round trip rather than a scan of its own. An empty prefix
 * is the whole vault.
 */
async function liveScanSize(ctx: McpRegistrationContext, prefix?: string): Promise<number> {
  const page = await indexQuery(ctx.env, "documents", { prefix, limit: 1000 }) as { documents?: unknown[] };
  return page.documents?.length ?? 0;
}

/**
 * The folders a caller can actually narrow to.
 *
 * "Add a prefix" is not advice when every top-level folder is itself too large — the caller then has to
 * guess. This names the ones that fit, so the remedy is a copy-pasteable value rather than a direction.
 */
async function narrowPrefixes(ctx: McpRegistrationContext, excluded: string | undefined, limit = 5): Promise<Array<{ prefix: string; documents: number }>> {
  const page = await indexQuery(ctx.env, "folders", {}) as { items?: Array<{ folder?: string; count?: number }> };
  return (page.items ?? [])
    .map(item => ({ folder: item.folder ?? "(root)", count: Number(item.count ?? 0) }))
    .filter(item => item.folder !== "(root)" && item.count <= limit && item.folder !== excluded?.replace(/\/$/, ""))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
    .map(item => ({ prefix: `${item.folder}/`, documents: item.count }));
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
          const result = await indexQuery(ctx.env, "search", { query, prefix, limit: max }) as {
            results?: unknown[]; partial?: boolean; staleDocuments?: number;
          };
          return ok(JSON.stringify({
            ...result,
            query,
            source: "index",
            // A search answered while documents are still unindexed is not a complete answer, and
            // saying so is the difference between "not found" and "not known yet".
            ...(result.partial ? { note: `索引回填中：${result.staleDocuments ?? "?"} 篇尚未索引，本次结果可能不完整。` } : {}),
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
          const count = await liveScanSize(ctx, prefix);
          if (count > MAX_LIVE_SCAN_DOCUMENTS) {
            return err(JSON.stringify({
              error: "vault_too_large_for_live_content_search",
              documents: count,
              limit: MAX_LIVE_SCAN_DOCUMENTS,
              scope: prefix ?? "(entire vault)",
              detail: `实时内容检索会对每篇候选文档发起一次读取：${prefix ? `前缀 ${prefix} 下` : "本 vault 共"} ${count} 篇，超过单次调用的安全上限 ${MAX_LIVE_SCAN_DOCUMENTS}。`,
              // Concrete enough to copy: an abstract "use a prefix" does not help when every
              // top-level folder is itself too large.
              narrowPrefixes: await narrowPrefixes(ctx, prefix),
              remedies: [
                "加 prefix 限定目录（见 narrowPrefixes 中能通过本上限的具体目录）",
                "按文件名/路径检索：search_text 且 readMode='index'、searchIn=['filename','path']（走索引，不受此限）",
                "按标签或frontmatter检索：tag_list_documents / search_frontmatter（走索引）",
              ],
            }, null, 2));
          }
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
