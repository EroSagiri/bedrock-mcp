import { WorkerEntrypoint, exports } from "cloudflare:workers";
import type { VaultHotRpc } from "@mineral/core/vault-rpc";
import ProductionVaultEntrypoint from "../../apps/vault/src/entrypoint";
import { VaultIndex as ProductionVaultIndex } from "../../apps/vault/src/durable/vault-index";
import SyncGateway from "../../apps/sync-gateway/src/index";
import { LiveDocumentRoom as ProductionLiveDocumentRoom } from "../../apps/sync-gateway/src/live-document-room";
import { NamespaceCoordinator as ProductionNamespaceCoordinator } from "../../apps/sync-gateway/src/namespace-coordinator";
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
const vaultBackgroundTasks = new Set<Promise<unknown>>();

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

  protected override runInBackground(work: Promise<unknown>): void {
    let tracked: Promise<unknown>;
    // WorkerEntrypoint RPC calls may be served by different class instances in the same isolate. The
    // tracker therefore belongs to the test isolate, not one entrypoint object, so teardown can see
    // every production waitUntil chain started by earlier RPC calls.
    tracked = work.finally(() => vaultBackgroundTasks.delete(tracked));
    vaultBackgroundTasks.add(tracked);
    super.runInBackground(tracked);
  }

  /** Waits for the production waitUntil chains without a wall-clock sleep at test teardown. */
  async drainBackgroundTasks(): Promise<void> {
    while (vaultBackgroundTasks.size > 0) await Promise.allSettled([...vaultBackgroundTasks]);
  }
}

export { RemoteChangeHub } from "../../apps/sync-gateway/src/remote-change-hub";
export { SyncGatewayEntrypoint } from "../../apps/sync-gateway/src/index";

/**
 * The hot Durable Objects, with the Vault reached the way the deployed service binding would.
 *
 * A Durable Object's environment is its own, so the test worker's `VAULT` proxy below does not reach
 * here. These two subclasses are the whole seam: production returns `env.VAULT`, and the test returns
 * the same Vault entrypoint the runtime constructed for this deployment. Everything else — the CRDT,
 * the SQLite state machine, the alarms, the conditional writes — stays production code.
 */
export class LiveDocumentRoom extends ProductionLiveDocumentRoom {
  /**
   * How many upcoming checkpoint calls should fail with a transport error.
   *
   * An R2 outage is the one failure a durability design has to survive rather than report, and it
   * cannot be produced from the outside: the room holds the pending target, the retry schedule, and the
   * receipt. This counter is the smallest possible seam — it changes *whether the call is made*, never
   * what the room does with the answer.
   */
  private failingCheckpoints = 0;

  failNextCheckpoints(count: number): void {
    this.failingCheckpoints = Math.max(0, Math.floor(count));
  }

  protected override vault(): VaultHotRpc | undefined {
    const real = (exports as unknown as { VaultEntrypoint: VaultHotRpc }).VaultEntrypoint;
    if (this.failingCheckpoints <= 0) return real;
    this.failingCheckpoints -= 1;
    return {
      observeHotPath: input => real.observeHotPath(input),
      checkpointHotDocument: async () => { throw new Error("r2 unavailable (test)"); },
      deleteHotDocument: input => real.deleteHotDocument(input),
      moveHotDocument: input => real.moveHotDocument(input),
    };
  }
}

export class NamespaceCoordinator extends ProductionNamespaceCoordinator {
  /**
   * How many upcoming namespace *deletes* should fail with a transport error.
   *
   * The coordinator's phase machine writes a phase before the act it describes, so an exception thrown
   * where the Vault call would be leaves exactly the state a crashed client leaves behind: an operation
   * recorded mid-flight and its path quiescing. That state cannot be produced from the outside (the DO
   * would have to be killed between two internal steps), and it is the state the resume alarm exists for.
   */
  private failingDeletes = 0;
  private failingMoves = 0;
  private lostMoveResponses = 0;

  failNextDeletes(count: number): void {
    this.failingDeletes = Math.max(0, Math.floor(count));
  }

  failNextMoves(count: number): void {
    this.failingMoves = Math.max(0, Math.floor(count));
  }

  loseNextMoveResponses(count: number): void {
    this.lostMoveResponses = Math.max(0, Math.floor(count));
  }

  protected override vault(): VaultHotRpc | undefined {
    const real = (exports as unknown as { VaultEntrypoint: VaultHotRpc }).VaultEntrypoint;
    if (this.failingDeletes <= 0 && this.failingMoves <= 0 && this.lostMoveResponses <= 0) return real;
    return {
      observeHotPath: input => real.observeHotPath(input),
      checkpointHotDocument: input => real.checkpointHotDocument(input),
      deleteHotDocument: input => {
        if (this.failingDeletes <= 0) return real.deleteHotDocument(input);
        this.failingDeletes -= 1;
        throw new Error("vault unavailable (test)");
      },
      moveHotDocument: async input => {
        if (this.failingMoves > 0) {
          this.failingMoves -= 1;
          throw new Error("vault unavailable (test)");
        }
        const result = await real.moveHotDocument(input);
        if (this.lostMoveResponses > 0) {
          this.lostMoveResponses -= 1;
          throw new Error("vault response lost after commit (test)");
        }
        return result;
      },
    };
  }
}

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
