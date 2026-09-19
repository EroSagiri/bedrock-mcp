import type { Env } from "../types";

export type ReadMode = "index" | "live";
export const readModeSchemaDescription = "index 使用周期性 Vault Metadata Index（最终一致）；live 直接全遍历原始 R2 Vault，较慢且消耗更高。";

export async function indexQuery(env: Env, kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault"));
  const response = await stub.fetch("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind, ...input }) });
  if (!response.ok) throw new Error(`VaultIndex query failed: ${response.status}`);
  return await response.json<Record<string, unknown>>();
}

export function liveMeta<T extends Record<string, unknown>>(value: T): T & { freshness: "live"; source: "live" } {
  return { ...value, freshness: "live", source: "live" };
}
