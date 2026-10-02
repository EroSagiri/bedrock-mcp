import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { GatewayEnv } from "../apps/sync-gateway/src/index";
import type { VaultWorkerEnv } from "../apps/vault/src/entrypoint";
import type { VaultIndex } from "../apps/vault/src/durable/vault-index";
import type { IndexIntentSpec } from "../apps/vault/src/index/intents";
import type { MutationJournal } from "../apps/vault/src/mutation/store";
import type { MutationEvent } from "../apps/vault/src/mutation/types";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import type { VaultRpc } from "@mineral/core/vault-rpc";
import type { VaultHotRpc } from "@mineral/core/vault-rpc";
import type { CheckpointReceipt } from "@mineral/sync-core/hot-protocol";
import { SqlMutationStore } from "../apps/vault/src/index/journal-store";

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

/** Measure actual workerd SQLite reads while unrelated edit history grows. */
export async function deletionIndexReadCost(extraPuts: number): Promise<{ before: number; after: number; paths: string[] }> {
  const namespace = bindings().VAULT_INDEX;
  const stub = namespace.getByName(`deletion-read-cost-${crypto.randomUUID()}`);
  return runInDurableObject(stub, (_instance, state) => {
    let reads = 0;
    const store = new SqlMutationStore({ exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const cursor = state.storage.sql.exec(query, ...bindings);
      const rows = [...cursor];
      reads += cursor.rowsRead;
      return rows as T[];
    } });
    store.record({ id: "cost_deleted", source: "obsidian", op: "delete", path: "deleted.md", etag: "D", committedAt: 1 }, []);
    reads = 0;
    store.listDeletionIndex({ limit: 10 });
    const before = reads;
    state.storage.transactionSync(() => {
      for (let i = 0; i < extraPuts; i++) state.storage.sql.exec("INSERT INTO mutation_journal (mutation_id, source, op, path, etag, size, committed_at, created_at) VALUES (?, 'obsidian', 'put', 'editing.md', ?, 1, ?, ?)", `cost_edit_${i}`, `E${i}`, i, i);
    });
    reads = 0;
    const page = store.listDeletionIndex({ limit: 10 });
    return { before, after: reads, paths: page.entries.map(entry => entry.path) };
  });
}

/** The deployed Gateway's RPC entrypoint, reached through the test worker's own exports. */
export function gatewayEntrypoint() {
  return exports.SyncGatewayEntrypoint as unknown as {
    markRemoteDirty(input: { channel: string; mutationId?: string; changes?: RemoteChange[] }): Promise<{ generation: string }>;
  };
}

/**
 * A hot document room, with the test deployment's failure seam.
 *
 * The seam lives in `test/worker/index.ts` (an R2 outage cannot be produced from outside the room), so
 * the extra method is asserted here rather than in every spec.
 */
export function hotRoom(documentId: string) {
  const namespace = bindings().ROOM;
  return namespace.getByName(documentId) as unknown as DurableObjectStub & {
    failNextCheckpoints(count: number): Promise<void>;
    describe(): Promise<{ latestAcceptedRevision: number; latestCheckpointedRevision: number; pendingSave: boolean; state: string } | null>;
    identity(): Promise<{ documentId: string; latestAcceptedRevision: number; latestCheckpointedRevision: number; pendingSave: boolean; state: string } | null>;
    lastReceipt(): Promise<CheckpointReceipt | null>;
    storageStats(): Promise<{ operations: number; snapshotRevision: number; latestAcceptedRevision: number; latestCheckpointedRevision: number; pendingTargetRevision: number | null; alarmAt: number | null } | null>;
  };
}

/** The hot checkpoint surface, as the Gateway's room calls it. */
export function vaultHotEntrypoint() {
  return (exports as unknown as { VaultEntrypoint: VaultHotRpc }).VaultEntrypoint;
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
    listDeletionIndex: input => real.listDeletionIndex(input),
  };
  return { journal, heal: () => { broken = false; } };
}


