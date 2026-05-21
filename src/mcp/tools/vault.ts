import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerVaultTools(ctx: McpRegistrationContext): void {
    // 列出文档（按修改时间倒序）
    registerToolCompat(ctx.server,
      "vault_list_documents",
      {
        prefix: z.string().optional().describe("路径前缀过滤，例如 'daily/' 只列日记目录"),
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
      "vault_list_folders",
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


    // 最近修改的笔记（默认 20 条，跨整个 vault）
    registerToolCompat(ctx.server,
      "vault_recent",
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


    // 列出 vault 里所有 #tag 及出现次数
    registerToolCompat(ctx.server,
      "vault_list_tags",
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


    // vault 总览统计
    registerToolCompat(ctx.server,
      "vault_stats",
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
}
