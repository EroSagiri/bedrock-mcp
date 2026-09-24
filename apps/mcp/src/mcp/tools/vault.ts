import { z } from "zod";
import { registerToolCompat } from "../compat";
import { relativeTime } from "../../utils/time";
import { readIndex, refreshIndex } from "../index-client";
import { err, ok, type McpRegistrationContext } from "../shared";

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
      { inputSchema: {} },
      async () => {
        const outcome = await readIndex(ctx.env, "folders", {});
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );


    // 最近修改的笔记（默认 20 条，跨整个 vault）
    registerToolCompat(ctx.server,
      "vault_recent",
      {
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional(),
          prefix: z.string().optional(),
        },
      },
      async ({ limit, prefix }) => {
        const outcome = await readIndex(ctx.env, "recent", { limit, prefix });
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );

    // vault 总览统计
    registerToolCompat(ctx.server,
      "vault_stats",
      { inputSchema: {} },
      async () => {
        const outcome = await readIndex(ctx.env, "stats", {});
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );
}