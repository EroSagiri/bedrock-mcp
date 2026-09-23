import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { GatewayEnv } from "../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../apps/vault/src/entrypoint";
import type { VaultIndex } from "../apps/vault/src/durable/vault-index";
import type { RemoteChange } from "@mineral/sync-core/sync-change";

/**
 * The bindings the integration test worker provides.
 *
 * The union exists only here: the test worker hosts both deployed Workers so one `SELF` can exercise
 * Vault → Gateway, while each Worker still declares only its own bindings in production. `bindings()`
 * is the single place that asserts the union, so no spec has to re-state the cast.
 */
export type TestBindings = VaultWorkerEnv & GatewayEnv;

export function bindings(): TestBindings {
  return env as unknown as TestBindings;
}

/** The single named Vault instance the journal and the note index live in. */
export function vaultIndex(): VaultIndex {
  const configured = bindings();
  return configured.VAULT_INDEX.get(configured.VAULT_INDEX.idFromName("vault")) as unknown as VaultIndex;
}

/** The deployed Gateway's RPC entrypoint, reached through the test worker's own exports. */
export function gatewayEntrypoint() {
  return exports.SyncGatewayEntrypoint as unknown as {
    markRemoteDirty(input: { channel: string; mutationId?: string; changes?: RemoteChange[] }): Promise<{ generation: string }>;
  };
}
