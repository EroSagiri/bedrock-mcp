import { WorkerEntrypoint, exports } from "cloudflare:workers";
import ProductionVaultEntrypoint from "../../apps/vault/src/entrypoint";
import { VaultIndex as ProductionVaultIndex } from "../../apps/vault/src/durable/vault-index";
import SyncGateway from "../../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../../apps/vault/src/entrypoint";
import type { GatewayEnv } from "../../apps/sync-gateway/src/index";
import type { VaultMutationBinding } from "../../apps/sync-gateway/src/mutations";
import { createFakeAi } from "../fake-ai";
import { createFakeVectorize } from "../fake-vectorize";

/**
 * The integration test worker.
 *
 * A single `SELF` fronts both deployed Workers, so one test can exercise
 * Vault → Mutation Journal → Sync Gateway without deploying anything. Requests are dispatched by
 * path prefix exactly as the deployment topology would: `/v1/**` belongs to the Gateway, everything
 * else to the Vault. Both Durable Objects and the R2 binding are hosted here too.
 */

/**
 * The Vault's two Workers, with the platform bindings Miniflare cannot simulate replaced.
 *
 * Workers AI and Vectorize are remote-only bindings: a local test either reaches the real API or has
 * nothing. So the test deployment supplies them, and everything the vector layer is actually made of —
 * the SQLite state machine, the acceptance rule, the drain, the RPC surface — stays the production code.
 * These are the only two overrides in the test worker, and production has no equivalent of either.
 */
const fakeAi = createFakeAi();

export class VaultIndex extends ProductionVaultIndex {
  private readonly fakeVectorize = createFakeVectorize();
  protected override embeddings() { return fakeAi; }
  protected override vectorIndexBinding() { return this.fakeVectorize; }

  /**
   * The Durable Object instance outlives a single test, and `resetMutationState` is the existing way a
   * test asks for a clean slate. The fake index has to follow it, or one test's vectors would appear as
   * candidates in the next one's search.
   */
  override async resetMutationState(): Promise<void> {
    await super.resetMutationState();
    this.fakeVectorize.clear();
  }
}

export class VaultEntrypoint extends ProductionVaultEntrypoint {
  protected override embeddings() { return fakeAi; }
}

export { RemoteChangeHub } from "../../apps/sync-gateway/src/remote-change-hub";
export { SyncGatewayEntrypoint } from "../../apps/sync-gateway/src/index";

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
