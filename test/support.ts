import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { GatewayEnv } from "../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../apps/vault/src/entrypoint";
import type { VaultIndex } from "../apps/vault/src/durable/vault-index";
import type { IndexIntentSpec } from "../apps/vault/src/index/intents";
import type { MutationJournal } from "../apps/vault/src/mutation/store";
import type { MutationEvent } from "../apps/vault/src/mutation/types";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import type { VaultRpc } from "@mineral/core/vault-rpc";

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

/**
 * The Vault's RPC entrypoint.
 *
 * The cast goes through `unknown` because the generated `Exports` type does not model an entrypoint
 * class re-exported under another name; the runtime surface is exactly `VaultRpc`.
 */
export function vaultEntrypoint(): VaultRpc {
  return (exports as unknown as { VaultEntrypoint: VaultRpc }).VaultEntrypoint;
}

/**
 * The real journal, with `recordMutation` made to fail until `heal()` is called.
 *
 * It exists so a test can produce the one state this layer treats as "R2 committed, journal did not":
 * every other method still reaches the real Durable Object, so the repair path under test is the
 * production one and only the failure is synthetic.
 */
export function failingJournal(message = "journal unavailable") {
  const real = vaultIndex() as unknown as MutationJournal;
  let broken = true;
  const journal: MutationJournal = {
    recordMutation: async input => {
      if (broken) throw new Error(message);
      return real.recordMutation(input);
    },
    findByMutationId: id => real.findByMutationId(id),
    listPendingBroadcasts: limit => real.listPendingBroadcasts(limit),
    markBroadcast: input => real.markBroadcast(input),
    pendingSummary: now => real.pendingSummary(now),
    listDueIndexPaths: (now, limit) => real.listDueIndexPaths(now, limit),
    claimPendingIndex: input => real.claimPendingIndex(input),
    completeIndex: input => real.completeIndex(input),
    failIndex: input => real.failIndex(input),
  };
  return { journal, heal: () => { broken = false; } };
}
