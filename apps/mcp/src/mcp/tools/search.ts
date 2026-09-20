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

export function registerSearchTools(ctx: McpRegistrationContext): void {

    // 全文检索（暴力扫描，适合小型 vault）
    registerToolCompat(ctx.server,
      "search_text",
      {
        query: z.string().min(1),
        regex: z.boolean().optional().describe("把 query 当正则。例：'^# .*会议' 找'# 会议'开头的标题"),
        caseSensitive: z.boolean().optional().describe("区分大小写，默认 false"),
        searchIn: z.array(z.enum(["content", "filename", "path", "frontmatter"]))
          .optional()
          .describe("搜索范围。默认 ['content','filename']。content 始终实时扫描原始 Markdown；frontmatter 请使用 search_frontmatter。"),
        prefix: z.string().optional().describe("限定目录，例如 'daily/'"),
        limit: z.number().int().min(1).max(200).optional(),
        contextChars: z.number().int().min(20).max(500).optional().describe("片段前后字符数，默认 60"),
        readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
      },
      async ({ query, regex, caseSensitive, searchIn, prefix, limit, contextChars, readMode }) => {
        const fields = new Set(searchIn ?? ["content", "filename"]);
        const snippetCtx = contextChars ?? 60;
        const max = limit ?? 20;
        const cs = caseSensitive ?? false;

        // Content/regex searches are deliberately always live. Simple filename
        // and path searches can use the metadata projection by default.
        if ((readMode ?? "index") === "index" && !regex && !fields.has("content") && !fields.has("frontmatter")) {
          return ok(JSON.stringify(await indexQuery(ctx.env, "filename-search", { query, prefix, limit: limit ?? 20 }), null, 2));
        }

        const matcher = buildMatcher(query, regex ?? false, cs);
        if ("error" in matcher) return err(matcher.error);

        const needsContent = fields.has("content") || fields.has("frontmatter");
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
