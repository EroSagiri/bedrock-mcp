import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerGraphTools(ctx: McpRegistrationContext): void {

    // 输出 wikilink 图谱：nodes + edges，可用于可视化或健康检查
    registerToolCompat(ctx.server,
      "graph_get",
      {
        prefix: z.string().optional().describe("限定目录"),
        includeDangling: z.boolean().optional().describe("是否包含指向不存在文件的边，默认 true"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多扫描多少篇文本笔记，默认 500"),
      },
      async ({ prefix, includeDangling, limit }) => {
        const files = await scanTextFiles(ctx.env.BEDROCK, prefix, (key, text, obj) => {
          if (key.startsWith(".history/") || key.startsWith(".trash/")) return null;
          return {
            key,
            title: (key.split("/").pop() ?? key).replace(/\.[^.]+$/, ""),
            modified: obj.uploaded.toISOString(),
            size: obj.size,
            links: extractWikilinks(text),
            tags: extractTags(text),
          };
        }, { max: limit ?? 500 });

        const targetIndex = new Map<string, string>();
        for (const file of files) {
          const noExt = stripTextExt(file.key);
          const basename = noExt.split("/").pop() ?? noExt;
          targetIndex.set(file.key, file.key);
          targetIndex.set(noExt, file.key);
          targetIndex.set(basename, file.key);
        }

        const edges: Array<{ from: string; to: string | null; link: string; dangling: boolean }> = [];
        for (const file of files) {
          for (const link of file.links) {
            const resolved = targetIndex.get(link) ?? targetIndex.get(stripTextExt(link)) ?? null;
            if (resolved || includeDangling !== false) {
              edges.push({ from: file.key, to: resolved, link, dangling: !resolved });
            }
          }
        }

        const degree = new Map<string, { in: number; out: number }>();
        for (const file of files) degree.set(file.key, { in: 0, out: 0 });
        for (const edge of edges) {
          const from = degree.get(edge.from);
          if (from) from.out++;
          if (edge.to) {
            const to = degree.get(edge.to);
            if (to) to.in++;
          }
        }

        const nodes = files.map(file => ({
          key: file.key,
          title: file.title,
          modified: file.modified,
          size: file.size,
          tags: file.tags,
          inDegree: degree.get(file.key)?.in ?? 0,
          outDegree: degree.get(file.key)?.out ?? 0,
        }));

        return ok(JSON.stringify({
          nodeCount: nodes.length,
          edgeCount: edges.length,
          danglingCount: edges.filter(e => e.dangling).length,
          nodes,
          edges,
        }, null, 2));
      }
    );


    // 找孤立笔记：没有入链/没有出链/完全孤立
    registerToolCompat(ctx.server,
      "graph_find_orphans",
      {
        prefix: z.string().optional().describe("限定目录"),
        mode: z.enum(["isolated", "noIncoming", "noOutgoing"]).optional().describe("默认 isolated"),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      async ({ prefix, mode, limit }) => {
        const files = await scanTextFiles(ctx.env.BEDROCK, prefix, (key, text, obj) => {
          if (key.startsWith(".history/") || key.startsWith(".trash/")) return null;
          return {
            key,
            modified: obj.uploaded.toISOString(),
            modifiedRelative: relativeTime(obj.uploaded),
            links: extractWikilinks(text),
            tags: extractTags(text),
            size: obj.size,
          };
        }, { max: limit ?? 1000 });

        const targetIndex = new Map<string, string>();
        for (const file of files) {
          const noExt = stripTextExt(file.key);
          const basename = noExt.split("/").pop() ?? noExt;
          targetIndex.set(file.key, file.key);
          targetIndex.set(noExt, file.key);
          targetIndex.set(basename, file.key);
        }

        const degrees = new Map<string, { in: number; out: number; dangling: number }>();
        for (const file of files) degrees.set(file.key, { in: 0, out: 0, dangling: 0 });
        for (const file of files) {
          const deg = degrees.get(file.key)!;
          for (const link of file.links) {
            deg.out++;
            const resolved = targetIndex.get(link) ?? targetIndex.get(stripTextExt(link)) ?? null;
            if (resolved) {
              const targetDeg = degrees.get(resolved);
              if (targetDeg) targetDeg.in++;
            } else {
              deg.dangling++;
            }
          }
        }

        const selectedMode = mode ?? "isolated";
        const items = files
          .map(file => ({ ...file, ...(degrees.get(file.key) ?? { in: 0, out: 0, dangling: 0 }) }))
          .filter(file => {
            if (selectedMode === "noIncoming") return file.in === 0;
            if (selectedMode === "noOutgoing") return file.out === 0;
            return file.in === 0 && file.out === 0;
          })
          .sort((a, b) => b.modified.localeCompare(a.modified))
          .map(file => ({
            key: file.key,
            modified: file.modified,
            modifiedRelative: file.modifiedRelative,
            size: file.size,
            tags: file.tags,
            inDegree: file.in,
            outDegree: file.out,
            danglingLinks: file.dangling,
          }));

        return ok(JSON.stringify({ mode: selectedMode, count: items.length, items }, null, 2));
      }
    );
}
