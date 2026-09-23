import { WorkerEntrypoint, exports } from "cloudflare:workers";
import VaultEntrypoint from "../../apps/vault/src/entrypoint";
import SyncGateway from "../../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../../apps/vault/src/entrypoint";
import type { GatewayEnv } from "../../apps/sync-gateway/src/index";
import type { VaultMutationBinding } from "../../apps/sync-gateway/src/mutations";

/**
 * The integration test worker.
 *
 * A single `SELF` fronts both deployed Workers, so one test can exercise
 * Vault → Mutation Journal → Sync Gateway without deploying anything. Requests are dispatched by
 * path prefix exactly as the deployment topology would: `/v1/**` belongs to the Gateway, everything
 * else to the Vault. Both Durable Objects and the R2 binding are hosted here too.
 */
export { RemoteChangeHub } from "../../apps/sync-gateway/src/remote-change-hub";
export { VaultIndex } from "../../apps/vault/src/durable/vault-index";
export { SyncGatewayEntrypoint } from "../../apps/sync-gateway/src/index";
export { default as VaultEntrypoint } from "../../apps/vault/src/entrypoint";

type TestEnv = VaultWorkerEnv & GatewayEnv;

/**
 * The Gateway's client-facing routes relay a reported mutation to a Vault. In production that is a
 * service binding; here the Vault is this same test worker's own entrypoint, reached through the
 * runtime's RPC stub exactly as a binding would reach it.
 *
 * The class is deliberately not instantiated here: a WorkerEntrypoint may only be constructed by the
 * runtime, so the stub is the only thing that behaves like the deployed binding.
 */
function bindings(env: TestEnv): TestEnv {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "VAULT") return (exports as unknown as { VaultEntrypoint: VaultMutationBinding }).VaultEntrypoint;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

export default class TestWorker extends WorkerEntrypoint<TestEnv> {
  async fetch(request: Request): Promise<Response> {
    const env = bindings(this.env);
    return new URL(request.url).pathname.startsWith("/v1/")
      ? new SyncGateway(this.ctx, env).fetch(request)
      : new VaultEntrypoint(this.ctx, env).fetch(request);
  }
}
