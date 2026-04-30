import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResourceCompat } from "./compat";
import { isTextFile } from "../storage/content";
import { scanTextFiles } from "../storage/r2";
import { extractTags } from "../utils/markdown";
import { relativeTime } from "../utils/time";
import { type McpRegistrationContext } from "./shared";

export function registerBedrockResources(ctx: McpRegistrationContext): void {

    // ---------- Resources ----------
    // MCP resources 让客户端可以"浏览"vault 而不是"调用"工具

    // 单篇文档（模板资源，按 key 取）
    registerResourceCompat(ctx.server,
      "res_doc",
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
      "res_vault_stats",
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
      "res_vault_recent",
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
      "res_vault_tags",
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
      "res_vault_folders",
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
      "res_doc_today",
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
      "res_doc_daily",
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
