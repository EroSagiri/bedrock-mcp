import type { VaultIndex } from "./durable/vault-index";

/**
 * Transitional in-process document port. Its concrete R2 implementation is
 * confined to Vault; callers depend on this named port rather than a binding.
 */
export type VaultDocuments = R2Bucket;

export type VaultIndexService = {
  query(kind: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refresh(): Promise<Record<string, unknown>>;
};

export type VaultService = {
  documents: VaultDocuments;
  index: VaultIndexService;
};

type VaultEnv = {
  MINERAL: R2Bucket;
  VAULT_INDEX: DurableObjectNamespace<VaultIndex>;
};

export function createVaultService(env: VaultEnv): VaultService {
  const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault"));
  return {
    documents: env.MINERAL,
    index: {
      async query(kind, input) {
        const response = await stub.fetch("https://vault-index/query", {
          method: "POST",
          body: JSON.stringify({ kind, ...input }),
        });
        if (!response.ok) throw new Error(`Vault index query failed: ${response.status}`);
        return response.json<Record<string, unknown>>();
      },
      async refresh() {
        const response = await stub.fetch("https://vault-index/refresh", { method: "POST", body: "{}" });
        if (!response.ok) throw new Error(`Vault index refresh failed: ${response.status}`);
        return response.json<Record<string, unknown>>();
      },
    },
  };
}
