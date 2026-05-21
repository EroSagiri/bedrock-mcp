import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerSearchTools(ctx: McpRegistrationContext): void {

    // 全文检索（暴力扫描，适合小型 vault）
    registerToolCompat(ctx.server,
      "search_text",
      {
        query: z.string().min(1),
        regex: z.boolean().optional().describe("把 query 当正则。例：'^# .*会议' 找'# 会议'开头的标题"),
        caseSensitive: z.boolean().optional().describe("区分大小写，默认 false"),
        searchIn: z.array(z.enum(["content", "filename", "path", "tags", "frontmatter"]))
          .optional()
          .describe("搜索范围。默认 ['content','filename']。content=正文，filename=文件名（含扩展），path=完整路径，tags=#标签，frontmatter=YAML 字段值"),
        prefix: z.string().optional().describe("限定目录，例如 'daily/'"),
        limit: z.number().int().min(1).max(200).optional(),
        contextChars: z.number().int().min(20).max(500).optional().describe("片段前后字符数，默认 60"),
      },
      async ({ query, regex, caseSensitive, searchIn, prefix, limit, contextChars }) => {
        const fields = new Set(searchIn ?? ["content", "filename"]);
        const snippetCtx = contextChars ?? 60;
        const max = limit ?? 20;
        const cs = caseSensitive ?? false;

        const matcher = buildMatcher(query, regex ?? false, cs);
        if ("error" in matcher) return err(matcher.error);

        const needsContent = fields.has("content") || fields.has("tags") || fields.has("frontmatter");
        type Hit = { in: string; field?: string; value?: string; snippet?: string };
        type FileResult = { key: string; modified: string; modifiedRelative: string; matches: Hit[] };
        const hits: FileResult[] = [];

        let cursor: string | undefined;
        scan: do {
          const r = await ctx.env.BEDROCK.list({ prefix, cursor, limit: 1000 });
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
                const obj = await ctx.env.BEDROCK.get(o.key);
                if (obj) {
                  const text = await obj.text();

                  if (fields.has("content")) {
                    const m = matcher.match(text);
                    if (m) matches.push({
                      in: "content",
                      snippet: snippetAt(text, m.index, m.length, snippetCtx),
                    });
                  }
                  if (fields.has("tags")) {
                    for (const tag of extractTags(text)) {
                      if (matcher.match(tag)) {
                        matches.push({ in: "tags", value: tag });
                        break;
                      }
                    }
                  }
                  if (fields.has("frontmatter")) {
                    const { frontmatter } = parseFrontmatter(text);
                    if (frontmatter) {
                      for (const [k, v] of Object.entries(frontmatter)) {
                        if (matcher.match(v) || matcher.match(k)) {
                          matches.push({ in: "frontmatter", field: k, value: v });
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
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);

        hits.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({
          query,
          regex: !!regex,
          caseSensitive: cs,
          searchIn: [...fields],
          count: hits.length,
          hits,
        }, null, 2));
      }
    );


    // 找带某个 tag 的所有笔记
    registerToolCompat(ctx.server,
      "search_tag",
      {
        tag: z.string().min(1).describe("形如 '#项目' 或 '项目'，自动补 #"),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ tag, prefix, limit }) => {
        const target = tag.startsWith("#") ? tag : `#${tag}`;
        const matches = await scanTextFiles(ctx.env.BEDROCK, prefix, (k, text, o) => {
          const tags = extractTags(text);
          // 支持嵌套 tag 匹配：#项目 也会命中 #项目/A
          const hit = tags.find(t => t === target || t.startsWith(target + "/"));
          if (!hit) return null;
          return {
            key: k,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            matchedTag: hit,
          };
        }, { max: limit ?? 100 });
        matches.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({ tag: target, count: matches.length, matches }, null, 2));
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
      },
      async ({ field, value, contains, prefix, limit }) => {
        const matches = await scanTextFiles(ctx.env.BEDROCK, prefix, (k, text, o) => {
          const { frontmatter } = parseFrontmatter(text);
          if (!frontmatter || !(field in frontmatter)) return null;
          const v = frontmatter[field];
          if (value !== undefined && v !== value) return null;
          if (contains !== undefined && !v.toLowerCase().includes(contains.toLowerCase())) return null;
          return {
            key: k,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            value: v,
          };
        }, { max: limit ?? 100 });
        matches.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({ field, value, contains, count: matches.length, matches }, null, 2));
      }
    );
}
