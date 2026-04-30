import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../types";
import { registerResourceCompat, registerToolCompat } from "./compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../storage/content";
import { backlinkTargets, scanTextFiles } from "../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../utils/search";
import { relativeTime } from "../utils/time";

type McpRegistrationContext = {
  env: Env;
  server: McpServer;
};

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export async function registerBedrockMcp(ctx: McpRegistrationContext): Promise<void> {
    // 列出文档（按修改时间倒序）
    registerToolCompat(ctx.server,
      "list_documents",
      {
        prefix: z.string().optional().describe("路径前缀过滤，例如 '日记/' 只列日记目录"),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      async ({ prefix, cursor, limit }) => {
        const r = await ctx.env.BEDROCK.list({
          prefix,
          cursor,
          limit: limit ?? 100,
          include: ["httpMetadata"],
        });
        const items = r.objects
          .map(o => ({
            key: o.key,
            size: o.size,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            contentType: o.httpMetadata?.contentType ?? null,
          }))
          .sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({
          count: items.length,
          cursor: r.truncated ? r.cursor : null,
          items,
        }, null, 2));
      }
    );

    // 列出顶层目录及其文件数（vault 全景）
    registerToolCompat(ctx.server,
      "list_folders",
      {},
      async () => {
        const folders = new Map<string, { count: number; lastModified: Date }>();
        let cursor: string | undefined;
        do {
          const r = await ctx.env.BEDROCK.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            const top = o.key.includes("/") ? o.key.split("/")[0] : "(root)";
            const cur = folders.get(top);
            if (!cur || cur.lastModified < o.uploaded) {
              folders.set(top, {
                count: (cur?.count ?? 0) + 1,
                lastModified: cur && cur.lastModified > o.uploaded ? cur.lastModified : o.uploaded,
              });
            } else {
              cur.count += 1;
            }
          }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        const items = [...folders.entries()]
          .map(([name, v]) => ({
            folder: name,
            count: v.count,
            lastModified: v.lastModified.toISOString(),
            lastModifiedRelative: relativeTime(v.lastModified),
          }))
          .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        return ok(JSON.stringify(items, null, 2));
      }
    );

    // 读取单个文档（解析 frontmatter / wikilinks / tags）
    registerToolCompat(ctx.server,
      "read_document",
      {
        key: z.string(),
        raw: z.boolean().optional().describe("true=只返回原始文本，不做解析"),
      },
      async ({ key, raw }) => {
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const text = await obj.text();
        if (raw) return ok(text);
        const { frontmatter, body } = parseFrontmatter(text);
        return ok(JSON.stringify({
          key,
          modified: obj.uploaded.toISOString(),
          size: obj.size,
          frontmatter,
          tags: extractTags(text),
          links: extractWikilinks(text),
          body,
        }, null, 2));
      }
    );

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
        prefix: z.string().optional().describe("限定目录，例如 '日记/'"),
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

    // 最近修改的笔记（默认 20 条，跨整个 vault）
    registerToolCompat(ctx.server,
      "get_recent",
      {
        limit: z.number().int().min(1).max(100).optional(),
        prefix: z.string().optional(),
      },
      async ({ limit, prefix }) => {
        const all: R2Object[] = [];
        let cursor: string | undefined;
        do {
          const r = await ctx.env.BEDROCK.list({ prefix, cursor, limit: 1000 });
          all.push(...r.objects);
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        const items = all
          .filter(o => isTextFile(o.key))
          .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
          .slice(0, limit ?? 20)
          .map(o => ({
            key: o.key,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            size: o.size,
          }));
        return ok(JSON.stringify(items, null, 2));
      }
    );

    // 日记快捷入口
    registerToolCompat(ctx.server,
      "get_daily_note",
      {
        date: z.string().optional().describe("YYYY-MM-DD，默认今天"),
        folder: z.string().optional().describe("日记目录，默认 '日记'"),
      },
      async ({ date, folder }) => {
        const dir = folder ?? "日记";
        const today = date ?? new Date().toISOString().slice(0, 10);
        // 尝试常见命名
        const candidates = [
          `${dir}/${today}.md`,
          `${dir}/${today.replace(/-/g, "")}.md`,
          `${dir}/${today.slice(0, 7)}/${today}.md`,
          `${dir}/${today.slice(0, 4)}/${today}.md`,
        ];
        for (const k of candidates) {
          const obj = await ctx.env.BEDROCK.get(k);
          if (obj) {
            return ok(JSON.stringify({
              key: k,
              modified: obj.uploaded.toISOString(),
              text: await obj.text(),
            }, null, 2));
          }
        }
        // 没找到精确匹配就模糊匹配该目录下含日期的文件
        const r = await ctx.env.BEDROCK.list({ prefix: `${dir}/`, limit: 1000 });
        const fuzzy = r.objects.filter(o => o.key.includes(today));
        return err(`未找到 ${today} 的日记。尝试过：\n${candidates.join("\n")}\n\n该目录下含 "${today}" 的文件：\n${fuzzy.map(o => o.key).join("\n") || "(无)"}`);
      }
    );

    // 写入/创建文档（覆盖式 put）
    registerToolCompat(ctx.server,
      "write_document",
      {
        key: z.string().min(1).describe("R2 对象 key，例如 '日记/2026-04-29.md'"),
        content: z.string().describe("文件全文内容（覆盖式写入）"),
        contentType: z.string().optional().describe("MIME 类型，.md 默认 text/markdown"),
      },
      async ({ key, content, contentType }) => {
        // 只允许文本扩展名，避免误把二进制当字符串写
        if (!isTextFile(key)) {
          return err(`仅允许写入文本文件 (${TEXT_EXTS.join(", ")})，收到: ${key}`);
        }

        const ct = textContentTypeForKey(key, contentType);
        const existed = await ctx.env.BEDROCK.head(key);
        await ctx.env.BEDROCK.put(key, encodeUtf8(content), {
          httpMetadata: { contentType: ct },
        });

        return ok(JSON.stringify({
          ok: true,
          key,
          action: existed ? "updated" : "created",
          size: encodeUtf8(content).length,
          contentType: ct,
        }, null, 2));
      }
    );

    // 删除文档
    registerToolCompat(ctx.server,
      "delete_document",
      { key: z.string().min(1) },
      async ({ key }) => {
        const existed = await ctx.env.BEDROCK.head(key);
        if (!existed) return err(`Not found: ${key}`);
        await ctx.env.BEDROCK.delete(key);
        return ok(JSON.stringify({ ok: true, key, deleted: true }, null, 2));
      }
    );

    // 批量删除（最多 100 个，防误操作）
    registerToolCompat(ctx.server,
      "delete_documents",
      { keys: z.array(z.string().min(1)).min(1).max(100) },
      async ({ keys }) => {
        await ctx.env.BEDROCK.delete(keys);
        return ok(JSON.stringify({ ok: true, deleted: keys.length, keys }, null, 2));
      }
    );

    // 严格创建：文件已存在则失败，避免 LLM 误覆盖
    registerToolCompat(ctx.server,
      "create_document",
      {
        key: z.string().min(1),
        content: z.string(),
        contentType: z.string().optional(),
      },
      async ({ key, content, contentType }) => {
        if (!isTextFile(key)) return err(`仅允许文本扩展名 (${TEXT_EXTS.join(", ")})，收到: ${key}`);
        const existed = await ctx.env.BEDROCK.head(key);
        if (existed) return err(`文件已存在，如需覆盖请用 write_document：${key}`);
        const ct = textContentTypeForKey(key, contentType);
        await ctx.env.BEDROCK.put(key, encodeUtf8(content), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({ ok: true, key, action: "created", contentType: ct }, null, 2));
      }
    );

    // 追加内容（适合日记/任务清单："在今天日记末尾加一句"）
    registerToolCompat(ctx.server,
      "append_to_document",
      {
        key: z.string().min(1),
        content: z.string(),
        separator: z.string().optional().describe("追加前的分隔符，默认 '\\n\\n'"),
        createIfMissing: z.boolean().optional().describe("文件不存在时是否新建，默认 true"),
      },
      async ({ key, content, separator, createIfMissing }) => {
        if (!isTextFile(key)) return err(`仅允许文本扩展名，收到: ${key}`);
        const obj = await ctx.env.BEDROCK.get(key);
        const sep = separator ?? "\n\n";
        let next: string;
        let action: "created" | "appended";
        if (!obj) {
          if (createIfMissing === false) return err(`Not found: ${key}`);
          next = content;
          action = "created";
        } else {
          const old = await obj.text();
          next = old.endsWith("\n") ? old + content : old + sep + content;
          action = "appended";
        }
        const ct = textContentTypeForKey(key, obj?.httpMetadata?.contentType);
        await ctx.env.BEDROCK.put(key, encodeUtf8(next), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({ ok: true, key, action, size: encodeUtf8(next).length }, null, 2));
      }
    );

    // 上传二进制文件（图片/PDF/任意类型，base64 传输）
    registerToolCompat(ctx.server,
      "upload_binary",
      {
        key: z.string().min(1).describe("R2 key，例如 '附件/photo.jpg'"),
        base64: z.string().min(1).describe("文件内容的 base64 编码"),
        contentType: z.string().optional().describe("MIME 类型；不传则按扩展名推断"),
      },
      async ({ key, base64, contentType }) => {
        // 解码 base64
        let bytes: Uint8Array;
        try {
          const bin = atob(base64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch {
          return err("base64 解码失败");
        }
        // 限制 10MB 避免 worker OOM
        const MAX = 10 * 1024 * 1024;
        if (bytes.byteLength > MAX) {
          return err(`文件过大 (${bytes.byteLength} bytes)，上限 ${MAX}。大文件请直接 PUT /static/<key> 或 POST /upload`);
        }
        const ct = contentType ?? guessContentType(key);
        await ctx.env.BEDROCK.put(key, bytes, { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({
          ok: true,
          key,
          size: bytes.byteLength,
          contentType: ct,
          publicPath: `/static/${key}`,
          tip: "用 get_public_url 拿完整 URL 嵌到 markdown 里",
        }, null, 2));
      }
    );

    // 取静态资源的公开 URL（用于嵌入 markdown / 分享）
    registerToolCompat(ctx.server,
      "get_public_url",
      {
        key: z.string().min(1),
      },
      async ({ key }) => {
        const obj = await ctx.env.BEDROCK.head(key);
        if (!obj) return err(`Not found: ${key}`);
        return ok(JSON.stringify({
          key,
          publicPath: `/static/${key}`,
          markdown: `![${key.split("/").pop()}](/static/${encodeURI(key)})`,
          note: "完整 URL 需要拼上 worker 域名，例如 https://bedrock-mcp.<account>.workers.dev/static/<key>。本地 dev 是 http://127.0.0.1:8787/static/<key>。",
          contentType: obj.httpMetadata?.contentType ?? null,
          size: obj.size,
        }, null, 2));
      }
    );

    // 创建文件夹（R2 没有真正的目录概念，写一个 .keep 占位文件）
    registerToolCompat(ctx.server,
      "create_folder",
      {
        path: z.string().min(1).describe("文件夹路径，例如 '新项目/草稿'"),
      },
      async ({ path }) => {
        const folder = path.replace(/\/+$/, "");
        const placeholder = `${folder}/.keep`;
        const existed = await ctx.env.BEDROCK.head(placeholder);
        if (existed) return ok(JSON.stringify({ ok: true, folder, action: "exists" }, null, 2));
        await ctx.env.BEDROCK.put(placeholder, encodeUtf8(""), {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        return ok(JSON.stringify({
          ok: true,
          folder,
          action: "created",
          note: "R2 没有真正的目录，已创建 .keep 占位。直接写入 '<folder>/xxx.md' 也会让目录'出现'。",
        }, null, 2));
      }
    );

    // 移动/重命名（copy + delete）
    registerToolCompat(ctx.server,
      "move_document",
      {
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
      },
      async ({ from, to, overwrite }) => {
        if (from === to) return err("from 和 to 相同");
        const src = await ctx.env.BEDROCK.get(from);
        if (!src) return err(`源文件不存在：${from}`);
        if (!overwrite) {
          const dst = await ctx.env.BEDROCK.head(to);
          if (dst) return err(`目标已存在，传 overwrite: true 强制覆盖：${to}`);
        }
        await ctx.env.BEDROCK.put(to, src.body, {
          httpMetadata: src.httpMetadata,
          customMetadata: src.customMetadata,
        });
        await ctx.env.BEDROCK.delete(from);
        return ok(JSON.stringify({ ok: true, from, to }, null, 2));
      }
    );

    // 反向链接：哪些笔记 [[link]] 到了这篇
    registerToolCompat(ctx.server,
      "find_backlinks",
      {
        key: z.string().min(1).describe("被链接的笔记，例如 '概念/二阶思考.md'"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ key, limit }) => {
        const targets = backlinkTargets(key);
        const matches = await scanTextFiles(ctx.env.BEDROCK, undefined, (k, text, o) => {
          if (k === key) return null; // 不返回自身
          const links = extractWikilinks(text);
          const hit = links.find(l => targets.has(l) || targets.has(l.split("/").pop() ?? ""));
          if (!hit) return null;
          return {
            key: k,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            via: hit,
            snippet: snippet(text, `[[${hit}`),
          };
        }, { max: limit ?? 100 });
        matches.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({ target: key, count: matches.length, matches }, null, 2));
      }
    );

    // 这篇笔记里链出去的 [[wikilinks]]
    registerToolCompat(ctx.server,
      "get_outgoing_links",
      { key: z.string().min(1) },
      async ({ key }) => {
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const text = await obj.text();
        const links = extractWikilinks(text);
        // 顺手探一下哪些是死链（vault 里搜不到对应文件）
        const checks = await Promise.all(links.map(async l => {
          // 尝试常见路径形式
          const candidates = [
            `${l}.md`,
            l, // 已经带扩展名的情况
          ];
          for (const c of candidates) {
            const h = await ctx.env.BEDROCK.head(c);
            if (h) return { link: l, resolved: c };
          }
          return { link: l, resolved: null };
        }));
        return ok(JSON.stringify({
          key,
          total: links.length,
          links: checks,
          deadLinks: checks.filter(c => !c.resolved).map(c => c.link),
        }, null, 2));
      }
    );

    // 列出 vault 里所有 #tag 及出现次数
    registerToolCompat(ctx.server,
      "list_tags",
      {
        prefix: z.string().optional().describe("限定目录"),
        minCount: z.number().int().min(1).optional().describe("最少出现次数，默认 1"),
      },
      async ({ prefix, minCount }) => {
        const counter = new Map<string, number>();
        await scanTextFiles(ctx.env.BEDROCK, prefix, (_k, text) => {
          for (const t of extractTags(text)) counter.set(t, (counter.get(t) ?? 0) + 1);
          return null;
        });
        const min = minCount ?? 1;
        const items = [...counter.entries()]
          .filter(([, n]) => n >= min)
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => ({ tag, count }));
        return ok(JSON.stringify({ totalUnique: items.length, tags: items }, null, 2));
      }
    );

    // 找带某个 tag 的所有笔记
    registerToolCompat(ctx.server,
      "search_by_tag",
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

    // vault 总览统计
    registerToolCompat(ctx.server,
      "get_vault_stats",
      {},
      async () => {
        const folderStats = new Map<string, { count: number; size: number; lastModified: Date }>();
        let totalCount = 0;
        let totalSize = 0;
        let textCount = 0;
        let textSize = 0;
        let largest: { key: string; size: number } | null = null;
        let smallest: { key: string; size: number } | null = null;
        let earliest: Date | null = null;
        let latest: Date | null = null;

        let cursor: string | undefined;
        do {
          const r = await ctx.env.BEDROCK.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            totalCount++;
            totalSize += o.size;
            if (isTextFile(o.key)) {
              textCount++;
              textSize += o.size;
            }
            if (!largest || o.size > largest.size) largest = { key: o.key, size: o.size };
            if (!smallest || o.size < smallest.size) smallest = { key: o.key, size: o.size };
            if (!earliest || o.uploaded < earliest) earliest = o.uploaded;
            if (!latest || o.uploaded > latest) latest = o.uploaded;

            const top = o.key.includes("/") ? o.key.split("/")[0] : "(root)";
            const cur = folderStats.get(top);
            if (cur) {
              cur.count++;
              cur.size += o.size;
              if (o.uploaded > cur.lastModified) cur.lastModified = o.uploaded;
            } else {
              folderStats.set(top, { count: 1, size: o.size, lastModified: o.uploaded });
            }
          }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);

        const folders = [...folderStats.entries()]
          .map(([name, v]) => ({
            folder: name,
            count: v.count,
            size: v.size,
            lastModified: v.lastModified.toISOString(),
            lastModifiedRelative: relativeTime(v.lastModified),
          }))
          .sort((a, b) => b.count - a.count);

        return ok(JSON.stringify({
          total: { count: totalCount, sizeBytes: totalSize },
          textFiles: { count: textCount, sizeBytes: textSize },
          binaryFiles: { count: totalCount - textCount, sizeBytes: totalSize - textSize },
          largest,
          smallest,
          earliest: earliest?.toISOString() ?? null,
          latest: latest?.toISOString() ?? null,
          latestRelative: latest ? relativeTime(latest) : null,
          folders,
        }, null, 2));
      }
    );

    // 按模板创建文件（替换 {{var}} 占位符）
    registerToolCompat(ctx.server,
      "create_from_template",
      {
        template: z.string().min(1).describe("模板文件 key，例如 '模板/日记.md'"),
        target: z.string().min(1).describe("目标 key，例如 '日记/2026-04-29.md'"),
        vars: z.record(z.string(), z.string()).optional().describe("替换变量；自动包含 date/time/datetime/title"),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
      },
      async ({ template, target, vars, overwrite }) => {
        const tpl = await ctx.env.BEDROCK.get(template);
        if (!tpl) return err(`模板不存在：${template}`);
        if (!overwrite) {
          const existed = await ctx.env.BEDROCK.head(target);
          if (existed) return err(`目标已存在，传 overwrite: true 强制覆盖：${target}`);
        }
        const tplText = await tpl.text();
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const titleFromTarget = (target.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
        const builtins: Record<string, string> = {
          date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
          time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
          datetime: now.toISOString(),
          title: titleFromTarget,
          ...(vars ?? {}),
        };
        // 替换 {{key}} 和 {{ key }}
        const rendered = tplText.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) =>
          builtins[k] !== undefined ? builtins[k] : `{{${k}}}`
        );
        const ct = textContentTypeForKey(target);
        await ctx.env.BEDROCK.put(target, encodeUtf8(rendered), { httpMetadata: { contentType: ct } });
        const unresolved = [...rendered.matchAll(/\{\{([\w-]+)\}\}/g)].map(m => m[1]);
        return ok(JSON.stringify({
          ok: true,
          template,
          target,
          appliedVars: builtins,
          unresolvedVars: [...new Set(unresolved)],
        }, null, 2));
      }
    );

    // 批量读取（一次拿多个文件的全文，省 round-trip）
    registerToolCompat(ctx.server,
      "read_multiple",
      {
        keys: z.array(z.string().min(1)).min(1).max(20),
      },
      async ({ keys }) => {
        const results = await Promise.all(keys.map(async k => {
          const obj = await ctx.env.BEDROCK.get(k);
          if (!obj) return { key: k, found: false };
          return {
            key: k,
            found: true,
            modified: obj.uploaded.toISOString(),
            text: await obj.text(),
          };
        }));
        return ok(JSON.stringify(results, null, 2));
      }
    );

    // ---------- Resources ----------
    // MCP resources 让客户端可以"浏览"vault 而不是"调用"工具

    // 单篇文档（模板资源，按 key 取）
    registerResourceCompat(ctx.server,
      "doc",
      new ResourceTemplate("bedrock://doc/{key}", {
        list: async () => {
          const r = await ctx.env.BEDROCK.list({ limit: 1000 });
          return {
            resources: r.objects.filter(o => isTextFile(o.key)).map(o => ({
              uri: `bedrock://doc/${o.key}`,
              name: o.key,
              description: `${o.size} bytes, ${relativeTime(o.uploaded)}`,
              mimeType: "text/markdown",
            })),
          };
        },
      }),
      async (uri, { key }) => {
        const obj = await ctx.env.BEDROCK.get(key as string);
        if (!obj) throw new Error(`Not found: ${key}`);
        return {
          contents: [{
            uri: uri.href,
            mimeType: obj.httpMetadata?.contentType ?? "text/markdown",
            text: await obj.text(),
          }],
        };
      }
    );

    // vault 总览（静态资源）
    registerResourceCompat(ctx.server,
      "vault-stats",
      "bedrock://stats",
      { description: "vault 总览：文件数、大小、目录分布、活跃度", mimeType: "application/json" },
      async (uri) => {
        const folderStats = new Map<string, { count: number; size: number; lastModified: Date }>();
        let totalCount = 0, totalSize = 0;
        let cursor: string | undefined;
        let latest: Date | null = null;
        do {
          const r = await ctx.env.BEDROCK.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            totalCount++;
            totalSize += o.size;
            if (!latest || o.uploaded > latest) latest = o.uploaded;
            const top = o.key.includes("/") ? o.key.split("/")[0] : "(root)";
            const cur = folderStats.get(top);
            if (cur) {
              cur.count++;
              cur.size += o.size;
              if (o.uploaded > cur.lastModified) cur.lastModified = o.uploaded;
            } else {
              folderStats.set(top, { count: 1, size: o.size, lastModified: o.uploaded });
            }
          }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              totalFiles: totalCount,
              totalSize,
              latest: latest?.toISOString() ?? null,
              latestRelative: latest ? relativeTime(latest) : null,
              folders: [...folderStats.entries()]
                .map(([name, v]) => ({
                  folder: name,
                  count: v.count,
                  size: v.size,
                  lastModified: v.lastModified.toISOString(),
                  lastModifiedRelative: relativeTime(v.lastModified),
                }))
                .sort((a, b) => b.count - a.count),
            }, null, 2),
          }],
        };
      }
    );

    // 最近修改（静态）
    registerResourceCompat(ctx.server,
      "recent-notes",
      "bedrock://recent",
      { description: "最近修改的 30 篇笔记", mimeType: "application/json" },
      async (uri) => {
        const all: R2Object[] = [];
        let cursor: string | undefined;
        do {
          const r = await ctx.env.BEDROCK.list({ cursor, limit: 1000 });
          all.push(...r.objects);
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        const items = all
          .filter(o => isTextFile(o.key))
          .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
          .slice(0, 30)
          .map(o => ({
            key: o.key,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            size: o.size,
          }));
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          }],
        };
      }
    );

    // 所有 tag 聚合（静态）
    registerResourceCompat(ctx.server,
      "all-tags",
      "bedrock://tags",
      { description: "vault 内所有 #tag 及出现次数（按频次倒序）", mimeType: "application/json" },
      async (uri) => {
        const counter = new Map<string, number>();
        await scanTextFiles(ctx.env.BEDROCK, undefined, (_k, text) => {
          for (const t of extractTags(text)) counter.set(t, (counter.get(t) ?? 0) + 1);
          return null;
        });
        const items = [...counter.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => ({ tag, count }));
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ totalUnique: items.length, tags: items }, null, 2),
          }],
        };
      }
    );

    // 顶层目录列表（静态）
    registerResourceCompat(ctx.server,
      "folders",
      "bedrock://folders",
      { description: "顶层目录及文件数", mimeType: "application/json" },
      async (uri) => {
        const folders = new Map<string, { count: number; lastModified: Date }>();
        let cursor: string | undefined;
        do {
          const r = await ctx.env.BEDROCK.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            const top = o.key.includes("/") ? o.key.split("/")[0] : "(root)";
            const cur = folders.get(top);
            if (cur) {
              cur.count++;
              if (o.uploaded > cur.lastModified) cur.lastModified = o.uploaded;
            } else {
              folders.set(top, { count: 1, lastModified: o.uploaded });
            }
          }
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        const items = [...folders.entries()]
          .map(([folder, v]) => ({
            folder,
            count: v.count,
            lastModified: v.lastModified.toISOString(),
            lastModifiedRelative: relativeTime(v.lastModified),
          }))
          .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          }],
        };
      }
    );

    // 今日日记（静态快捷方式）
    registerResourceCompat(ctx.server,
      "today",
      "bedrock://today",
      { description: "今天的日记（自动按 日记/YYYY-MM-DD.md 查找）", mimeType: "text/markdown" },
      async (uri) => {
        const today = new Date().toISOString().slice(0, 10);
        const candidates = [
          `日记/${today}.md`,
          `日记/${today.replace(/-/g, "")}.md`,
          `日记/${today.slice(0, 7)}/${today}.md`,
          `日记/${today.slice(0, 4)}/${today}.md`,
        ];
        for (const k of candidates) {
          const obj = await ctx.env.BEDROCK.get(k);
          if (obj) {
            return {
              contents: [{
                uri: uri.href,
                mimeType: "text/markdown",
                text: await obj.text(),
              }],
            };
          }
        }
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `今天 (${today}) 还没有日记。尝试过：\n${candidates.join("\n")}`,
          }],
        };
      }
    );

    // 日记按日期（模板）
    registerResourceCompat(ctx.server,
      "daily",
      new ResourceTemplate("bedrock://daily/{date}", {
        list: async () => {
          const r = await ctx.env.BEDROCK.list({ prefix: "日记/", limit: 1000 });
          return {
            resources: r.objects
              .filter(o => /\d{4}-?\d{2}-?\d{2}/.test(o.key))
              .map(o => {
                const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(o.key);
                const date = m ? `${m[1]}-${m[2]}-${m[3]}` : o.key;
                return {
                  uri: `bedrock://daily/${date}`,
                  name: date,
                  description: `${relativeTime(o.uploaded)}`,
                  mimeType: "text/markdown",
                };
              }),
          };
        },
      }),
      async (uri, { date }) => {
        const d = String(date);
        const candidates = [
          `日记/${d}.md`,
          `日记/${d.replace(/-/g, "")}.md`,
          `日记/${d.slice(0, 7)}/${d}.md`,
          `日记/${d.slice(0, 4)}/${d}.md`,
        ];
        for (const k of candidates) {
          const obj = await ctx.env.BEDROCK.get(k);
          if (obj) {
            return {
              contents: [{ uri: uri.href, mimeType: "text/markdown", text: await obj.text() }],
            };
          }
        }
        throw new Error(`未找到 ${d} 的日记`);
      }
    );
}
