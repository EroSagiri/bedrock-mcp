import { WorkerEntrypoint } from "cloudflare:workers";
import VaultEntrypoint from "../../apps/vault/src/entrypoint";
import SyncGateway from "../../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../../apps/vault/src/entrypoint";
import type { GatewayEnv } from "../../apps/sync-gateway/src/index";

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

export default class TestWorker extends WorkerEntrypoint<TestEnv> {
  async fetch(request: Request): Promise<Response> {
    return new URL(request.url).pathname.startsWith("/v1/")
      ? new SyncGateway(this.ctx, this.env).fetch(request)
      : new VaultEntrypoint(this.ctx, this.env).fetch(request);
  }
}
