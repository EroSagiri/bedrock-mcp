import { z } from "zod";
import { registerToolCompat } from "../compat";
import { readIndex } from "../index-client";
import { ok, type McpRegistrationContext } from "../shared";

/**
 * The wikilink graph lives in the index.
 *
 * `links` holds one row per outgoing link per document, which is exactly the edge set, so the graph is an
 * indexed query rather than a walk over every note's text. The walk existed as an alternative answer to
 * the same question at one document read per note — on this vault that is also a hard failure, and a
 * caller had no way to know which of the two they had asked for.
 */
export function registerGraphTools(ctx: McpRegistrationContext): void {
  registerToolCompat(
    ctx.server,
    "graph_get",
    {
      inputSchema: {
        prefix: z.string().optional().describe("只返回该路径前缀下的节点"),
        includeDangling: z.boolean().optional().describe("包含未解析的出链，默认 true"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多返回多少个节点，默认 500"),
      },
    },
    async ({ prefix, includeDangling, limit }) => {
      const outcome = await readIndex(ctx.env, "graph", { prefix, includeDangling, limit });
      if (!outcome.ok) return outcome.result;
      return ok(JSON.stringify(outcome.data, null, 2));
    }
  );

  registerToolCompat(
    ctx.server,
    "graph_neighbors",
    {
      inputSchema: {
        key: z.string().min(1).describe("作为中心的笔记 key"),
        depth: z.number().int().min(1).max(3).optional().describe("邻域深度，默认 1"),
        prefix: z.string().optional().describe("只返回该路径前缀下的节点"),
        includeDangling: z.boolean().optional().describe("包含未解析的出链，默认 true"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多返回多少个节点，默认 500"),
      },
    },
    async ({ key, depth, prefix, includeDangling, limit }) => {
      const outcome = await readIndex(ctx.env, "graph", { operation: "neighbors", key, depth, prefix, includeDangling, limit });
      if (!outcome.ok) return outcome.result;
      return ok(JSON.stringify(outcome.data, null, 2));
    }
  );

  registerToolCompat(
    ctx.server,
    "graph_find_orphans",
    {
      inputSchema: {
        prefix: z.string().optional().describe("只在该路径前缀内查找"),
        mode: z.enum(["isolated", "noIncoming", "noOutgoing"]).optional().describe("默认 isolated"),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ prefix, mode, limit }) => {
      const outcome = await readIndex(ctx.env, "graph", { operation: "orphans", mode, prefix, limit });
      if (!outcome.ok) return outcome.result;
      return ok(JSON.stringify(outcome.data, null, 2));
    }
  );
}
