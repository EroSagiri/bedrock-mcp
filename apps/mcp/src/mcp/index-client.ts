import type { Env } from "../types";

export type ReadMode = "index" | "live";
export const readModeSchemaDescription = "index 使用周期性 Vault Metadata Index（最终一致）；live 直接全遍历原始 R2 Vault，较慢且消耗更高。";

export async function indexQuery(env: Env, kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return env.vault.index.query(kind, input);
}

/** Starts a new metadata generation, or reports the one already building. */
/**
 * Starts a revision audit, or reports the one already running.
 *
 * The name outlived its meaning: there is no metadata generation to rebuild, so this asks the Vault to
 * walk R2, diff it against the live index, and enqueue the difference for the indexer.
 */
export async function refreshIndex(env: Env): Promise<Record<string, unknown>> {
  return env.vault.index.refresh();
}

export function liveMeta<T extends Record<string, unknown>>(value: T): T & { freshness: "live"; source: "live" } {
  return { ...value, freshness: "live", source: "live" };
}


