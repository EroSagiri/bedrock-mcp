import { z } from "zod";
import { registerToolCompat } from "../compat";
import { buildGraph, buildNeighborGraph } from "../graph-data";
import { scanTextFiles } from "../../vault-client";
import { extractTags, extractWikilinks } from "../../utils/markdown";
import { relativeTime } from "../../utils/time";
import { ok, stripTextExt, type McpRegistrationContext } from "../shared";
import { indexQuery, readModeSchemaDescription } from "../index-client";

export function registerGraphTools(ctx: McpRegistrationContext): void {
  registerToolCompat(
    ctx.server,
    "graph_get",
    {
      prefix: z.string().optional().describe("Limit scanned notes by prefix"),
      includeDangling: z.boolean().optional().describe("Include unresolved outgoing links, default true"),
      limit: z.number().int().min(1).max(2000).optional().describe("Maximum scanned text notes, default 500"),
      readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
    },
    async ({ prefix, includeDangling, limit, readMode }) => ok(JSON.stringify(
      (readMode ?? "index") === "index" ? await indexQuery(ctx.env, "graph", { prefix, includeDangling, limit }) : { ...(await buildGraph(ctx.env.vault.documents, { prefix, includeDangling, limit })), source: "live", freshness: "live" },
      null,
      2
    ))
  );

  registerToolCompat(
    ctx.server,
    "graph_neighbors",
    {
      key: z.string().min(1).describe("Note key to center the graph on"),
      depth: z.number().int().min(1).max(3).optional().describe("Neighborhood depth, default 1"),
      prefix: z.string().optional().describe("Limit scanned notes by prefix"),
      includeDangling: z.boolean().optional().describe("Include unresolved outgoing links, default true"),
      limit: z.number().int().min(1).max(2000).optional().describe("Maximum scanned text notes, default 500"),
      readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
    },
    async ({ key, depth, prefix, includeDangling, limit, readMode }) => ok(JSON.stringify(
      (readMode ?? "index") === "index" ? await indexQuery(ctx.env, "graph", { operation: "neighbors", key, depth, prefix, includeDangling, limit }) : { ...(await buildNeighborGraph(ctx.env.vault.documents, key, depth ?? 1, { prefix, includeDangling, limit })), source: "live", freshness: "live" },
      null,
      2
    ))
  );

  registerToolCompat(
    ctx.server,
    "graph_find_orphans",
    {
      prefix: z.string().optional().describe("Limit scanned notes by prefix"),
      mode: z.enum(["isolated", "noIncoming", "noOutgoing"]).optional().describe("Default isolated"),
      limit: z.number().int().min(1).max(1000).optional(),
      readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
    },
    async ({ prefix, mode, limit, readMode }) => {
      if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "graph", { operation: "orphans", mode, prefix, limit }), null, 2));
      const files = await scanTextFiles(ctx.env.vault.documents, prefix, (key, text, obj) => {
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
