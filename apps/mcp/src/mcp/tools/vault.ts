import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "@mineral/core/content";
import { backlinkTargets, scanTextFiles } from "../../vault-client";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { indexQuery, readModeSchemaDescription, refreshIndex } from "../index-client";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerVaultTools(ctx: McpRegistrationContext): void {
    /**
     * The one tool whose job is to measure rather than to report.
     *
     * A Vectorize index keeps its width and metric forever, so the width has to come from the deployed
     * model instead of from documentation. It is registered here, next to the index tools, because it
     * answers the same kind of question: what can this deployment actually do?
     */
    registerToolCompat(ctx.server,
      "vault_embedding_probe",
      {
        inputSchema: {
          model: z.string().optional().describe("要探测的模型；默认使用冻结的向量模型"),
        },
      },
      async ({ model }) => {
        const result = await ctx.env.vault.probeEmbeddingModel(model);
        if (!result) return err("此 Vault 未配置 AI binding，无法回答向量宽度");
        return result.matchesExpectedDimensions
          ? ok(JSON.stringify(result, null, 2))
          : err(JSON.stringify(result, null, 2));
      }
    );

    registerToolCompat(ctx.server,
      "vault_index_refresh",
      {
        inputSchema: {},
        annotations: { idempotentHint: true },
      },
      async () => ok(JSON.stringify(await refreshIndex(ctx.env), null, 2))
    );

    // 列出文档（按修改时间倒序）
    registerToolCompat(ctx.server,
      "vault_list_documents",
      {
        prefix: z.string().optional().describe("路径前缀过滤，例如 'daily/' 只列日记目录"),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      async ({ prefix, cursor, limit }) => {
        const r = await ctx.env.vault.documents.list({
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
      { readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription) },
      async ({ readMode }) => {
        if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "folders", {}), null, 2));
        const folders = new Map<string, { count: number; lastModified: Date }>();
        let cursor: string | undefined;
        do {
          const r = await ctx.env.vault.documents.list({ cursor, limit: 1000 });
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
          cursor = r.cursor ?? undefined;
        } while (cursor);
        const items = [...folders.entries()]
          .map(([name, v]) => ({
            folder: name,
            count: v.count,
            lastModified: v.lastModified.toISOString(),
            lastModifiedRelative: relativeTime(v.lastModified),
          }))
          .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        return ok(JSON.stringify({ items, source: "live", freshness: "live" }, null, 2));
      }
    );


    // 最近修改的笔记（默认 20 条，跨整个 vault）
    registerToolCompat(ctx.server,
      "vault_recent",
      {
        limit: z.number().int().min(1).max(100).optional(),
        prefix: z.string().optional(),
        readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
      },
      async ({ limit, prefix, readMode }) => {
        if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "recent", { limit, prefix }), null, 2));
        const all: Awaited<ReturnType<typeof ctx.env.vault.documents.list>>["items"] = [];
        let cursor: string | undefined;
        do {
          const r = await ctx.env.vault.documents.list({ prefix, cursor, limit: 1000 });
          all.push(...r.objects);
          cursor = r.cursor ?? undefined;
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
        return ok(JSON.stringify({ items, source: "live", freshness: "live" }, null, 2));
      }
    );
    // vault 总览统计
    registerToolCompat(ctx.server,
      "vault_stats",
      { readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription) },
      async ({ readMode }) => {
        if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "stats", {}), null, 2));
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
          const r = await ctx.env.vault.documents.list({ cursor, limit: 1000 });
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
          cursor = r.cursor ?? undefined;
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
          source: "live", freshness: "live",
        }, null, 2));
      }
    );
}
