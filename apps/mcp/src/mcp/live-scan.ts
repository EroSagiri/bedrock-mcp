import { err, type McpRegistrationContext } from "./shared";
import { indexQuery } from "./index-client";

/**
 * The largest live scan a tool will start.
 *
 * A live scan reads every candidate document through the Vault RPC, so the vault's size *is* the
 * subrequest count, and a Worker has a hard ceiling on those. Past it the runtime kills the invocation
 * mid-scan with "Too many subrequests by single Worker invocation" — an error that names neither the
 * cause nor the remedy, and that a vault crosses silently as it grows.
 *
 * So the size is checked first and refused with something actionable. The bound is deliberately
 * conservative: the ceiling itself depends on the account's plan, and a scan this refuses is one
 * `prefix` away from running.
 *
 * It lives here rather than in the search tool because every tool with a `readMode` has the same
 * obligation. A tag scan that walks the vault is not cheaper than a content scan, and a tag tool that
 * walks it unbounded fails exactly the same way.
 */
export const MAX_LIVE_SCAN_DOCUMENTS = 200;

/**
 * How many documents a live scan with this prefix would read.
 *
 * Answered from the index in one projection read — the Documents list is the same one every other
 * indexed query uses, so this costs a single round trip rather than a scan of its own. An empty prefix
 * is the whole vault.
 */
export async function liveScanSize(ctx: McpRegistrationContext, prefix?: string): Promise<number> {
  const page = await indexQuery(ctx.env, "documents", { prefix, limit: 1000 }) as { documents?: unknown[] };
  return page.documents?.length ?? 0;
}

/**
 * The folders a caller can actually narrow to.
 *
 * "Add a prefix" is not advice when every top-level folder is itself too large — the caller then has to
 * guess. This names the ones that fit, so the remedy is a copy-pasteable value rather than a direction.
 */
export async function narrowPrefixes(ctx: McpRegistrationContext, excluded: string | undefined, limit = 5): Promise<Array<{ prefix: string; documents: number }>> {
  const page = await indexQuery(ctx.env, "folders", {}) as { items?: Array<{ folder?: string; count?: number }> };
  return (page.items ?? [])
    .map(item => ({ folder: item.folder ?? "(root)", count: Number(item.count ?? 0) }))
    .filter(item => item.folder !== "(root)" && item.count <= limit && item.folder !== excluded?.replace(/\/$/, ""))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
    .map(item => ({ prefix: `${item.folder}/`, documents: item.count }));
}

/**
 * Refuses a live scan that would be killed by the runtime, or `null` when it fits.
 *
 * `operation` names what was being asked for, so the refusal says which live path was too expensive
 * rather than reading as a generic failure — and `indexRemedy` names the tool that answers the same
 * question from the index, because "add a prefix" is not always an option a caller has.
 */
export async function refuseLargeLiveScan(
  ctx: McpRegistrationContext,
  input: { prefix?: string; operation: string; indexRemedy: string },
): Promise<ReturnType<typeof err> | null> {
  const count = await liveScanSize(ctx, input.prefix);
  if (count <= MAX_LIVE_SCAN_DOCUMENTS) return null;
  return err(JSON.stringify({
    error: "vault_too_large_for_live_scan",
    operation: input.operation,
    documents: count,
    limit: MAX_LIVE_SCAN_DOCUMENTS,
    scope: input.prefix ?? "(entire vault)",
    detail: `实时模式会对每篇候选文档发起一次读取：${input.prefix ? `前缀 ${input.prefix} 下` : "本 vault 共"} ${count} 篇，超过单次调用的安全上限 ${MAX_LIVE_SCAN_DOCUMENTS}。`,
    // Concrete enough to copy: an abstract "use a prefix" does not help when every top-level folder is
    // itself too large.
    narrowPrefixes: await narrowPrefixes(ctx, input.prefix),
    remedies: [
      input.indexRemedy,
      "加 prefix 限定目录（见 narrowPrefixes 中能通过本上限的具体目录）",
    ],
  }, null, 2));
}
