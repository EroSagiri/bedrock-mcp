import type { Env as GatewayEnv } from "../../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../../apps/vault/src/entrypoint";

/**
 * The bindings the integration test worker provides.
 *
 * They are the union of both deployed Workers' environments, because the test worker hosts both so
 * that one `SELF` can exercise Vault → Gateway. Nothing here weakens production: each Worker still
 * declares only its own bindings, and these types are only reachable from `test/`.
 *
 * `Env` is the global that the generated `worker-configuration.d.ts` declares, and the one
 * `cloudflare:test` types its `env` export as, so extending it is what types the test bindings.
 */
type TestEnv = VaultWorkerEnv & GatewayEnv;

declare global {
  interface Env extends TestEnv {}
}
