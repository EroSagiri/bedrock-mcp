import { SELF } from "cloudflare:test";
import { bindings, gatewayEntrypoint } from "./support";

import { describe, expect, it } from "vitest";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore } from "../apps/vault/src/mutation/store";
import { createMutationRecorder } from "../apps/vault/src/mutation/recorder";
import { indexIntentsFor, OBSIDIAN_INDEX_DEBOUNCE_MS } from "../apps/vault/src/index/intents";
import type { MutationEvent } from "../apps/vault/src/mutation/types";
import { drainSyncOutbox, publishMutation, PUBLISH_BATCH_LIMIT } from "../apps/vault/src/sync-publisher/publisher";
import type { GatewayPublisher } from "../apps/vault/src/sync-publisher/gateway-port";
import { createGatewayPublisher } from "../apps/vault/src/sync-publisher/gateway-rpc";
import type { RemoteChange } from "@mineral/sync-core/sync-change";

/** A fake gateway that mints generations the way the real Hub does, keyed by mutationId. */
function fakeGateway(options: { failUntil?: number } = {}) {
  const generations = new Map<string, string>();
  const received: Array<{ mutationId: string; changes: RemoteChange[] }> = [];
  let next = 0;
  let calls = 0;
  const failUntil = options.failUntil ?? 0;
  const publisher = {
    async publish(event: MutationEvent & { mutationId: string }) {
      calls++;
      if (calls <= failUntil) return { ok: false as const, kind: "transport" as const };
      const existing = generations.get(event.mutationId);
      if (existing) return { ok: true as const, generation: existing };
      const generation = String(++next);
      generations.set(event.mutationId, generation);
      received.push({ mutationId: event.mutationId, changes: event.op === "delete" ? [{ op: "delete", path: event.path }] : [{ op: "put", path: event.path }] });
      return { ok: true as const, generation };
    },
  } satisfies GatewayPublisher;
  return { generations, received, publisher, get calls() { return calls; } };
}

function harness(gateway: GatewayPublisher = fakeGateway().publisher) {
  const store = new MemoryMutationStore();
  const journal = journalFromStore(store);
  let id = 0;
  const recorder = createMutationRecorder({ journal, nextId: () => `mut_pub_${++id}`, now: () => 1_000 });
  return { store, journal, gateway, dependencies: { journal, gateway }, recorder };
}

describe("Sync Publisher (outbox)", () => {
  it("publishes an MCP mutation and an Obsidian mutation to the gateway", async () => {
    const gateway = fakeGateway();
    const { dependencies, recorder } = harness(gateway.publisher);
    const mcp = await recorder.record({ source: "mcp", op: "put", path: "notes/mcp.md", etag: "M1", size: 1 });
    const obsidian = await recorder.record({ source: "obsidian", op: "put", path: "notes/obsidian.md", etag: "O1", size: 2 });

    await publishMutation(dependencies, mcp.id);
    expect(await drainSyncOutbox(dependencies)).toMatchObject({ published: 1, failed: 0 });

    expect([...gateway.generations.keys()]).toEqual([mcp.id, obsidian.id]);
    expect([...gateway.generations.values()]).toEqual(["1", "2"]);
    expect(gateway.received[1].changes).toEqual([{ op: "put", path: "notes/obsidian.md" }]);
  });

  it("keeps a fact pending when the gateway is unavailable and publishes it on a later drain", async () => {
    const gateway = fakeGateway({ failUntil: 1 });
    const { store, journal, dependencies, recorder } = harness(gateway.publisher);
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "notes/retry.md", etag: "R1", size: 3 });

    await drainSyncOutbox(dependencies);
    const pending = await journal.findByMutationId(recorded.id);
    expect(pending).toMatchObject({ broadcastState: "pending", broadcastLastError: "transport" });
    expect(pending!.gatewayGeneration).toBeNull();
    // The journal fact and the index intent survive the delivery failure untouched: a gateway
    // outage is not allowed to erase work that a different consumer still owes.
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(store.snapshotIntents()).toHaveLength(1);

    expect(await drainSyncOutbox(dependencies)).toMatchObject({ published: 1, failed: 0 });
    await expect(journal.findByMutationId(recorded.id)).resolves.toMatchObject({ broadcastState: "published", gatewayGeneration: "1" });
    expect(store.snapshotIntents()).toHaveLength(1);
  });

  it("never mints a second gateway generation for the same mutation id", async () => {
    const gateway = fakeGateway();
    const { dependencies, recorder } = harness(gateway.publisher);
    const recorded = await recorder.record({ source: "obsidian", op: "put", path: "notes/once.md", etag: "X", size: 1 });

    await publishMutation(dependencies, recorded.id);
    // Redeliveries — a retry after a lost response, a crash-recovery drain, a scheduled drain.
    await publishMutation(dependencies, recorded.id);
    await publishMutation(dependencies, recorded.id);
    await drainSyncOutbox(dependencies);

    expect(gateway.calls).toBe(1);
    expect(gateway.generations.size).toBe(1);
    expect(gateway.generations.get(recorded.id)).toBe("1");
  });

  it("does not call the gateway again when the journal still holds the generation", async () => {
    const calls: string[] = [];
    const publisher: GatewayPublisher = { async publish(event) { calls.push(event.mutationId); return { ok: true, generation: "5" }; } };
    const { dependencies, recorder } = harness(publisher);
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "notes/replay.md", etag: "Y", size: 1 });
    await drainSyncOutbox(dependencies);
    expect(calls).toEqual([recorded.id]);

    // A replay of the same id must reuse the recorded generation rather than publish again.
    await expect(publishMutation(dependencies, recorded.id)).resolves.toEqual({ ok: true, generation: "5" });
    expect(calls).toEqual([recorded.id]);
  });

  it("bounds one drain to a fixed batch", async () => {
    const gateway = fakeGateway();
    const { dependencies, recorder } = harness(gateway.publisher);
    for (let index = 0; index < PUBLISH_BATCH_LIMIT + 3; index++) {
      await recorder.record({ source: "mcp", op: "put", path: `notes/batch-${index}.md`, etag: `E${index}`, size: 1 });
    }
    expect(await drainSyncOutbox(dependencies)).toMatchObject({ attempted: PUBLISH_BATCH_LIMIT, published: PUBLISH_BATCH_LIMIT });
    expect(await drainSyncOutbox(dependencies)).toMatchObject({ attempted: 3, published: 3 });
  });

  it("leaves a gateway failure unable to change a successful R2 write", async () => {
    const gateway = fakeGateway({ failUntil: 99 });
    const { dependencies, recorder, store } = harness(gateway.publisher);
    // The write itself already succeeded before the publisher runs; recording must not throw.
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "notes/written.md", etag: "W", size: 1 });
    await expect(drainSyncOutbox(dependencies)).resolves.toMatchObject({ published: 0, failed: 1 });

    expect(recorded.inserted).toBe(true);
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(store.snapshotJournal()[0].broadcastState).toBe("pending");
  });
});

describe("Gateway mutationId idempotency (the real Hub)", () => {
  const channel = "Z".repeat(43);
  const entrypoint = gatewayEntrypoint();

  it("returns the original generation for a repeated mutation id and does not advance", async () => {
    const first = await entrypoint.markRemoteDirty({ channel, mutationId: "mut_hub_1", changes: [{ op: "put", path: "hub/a.md", etag: "A" }] });
    const retry = await entrypoint.markRemoteDirty({ channel, mutationId: "mut_hub_1", changes: [{ op: "put", path: "hub/a.md", etag: "A" }] });
    const other = await entrypoint.markRemoteDirty({ channel, mutationId: "mut_hub_2" });

    expect(retry.generation).toBe(first.generation);
    expect(other.generation).toBe(String(BigInt(first.generation) + 1n));
  });

  it("keeps the legacy level-triggered behaviour when no mutation id is sent", async () => {
    const before = await entrypoint.markRemoteDirty({ channel });
    const after = await entrypoint.markRemoteDirty({ channel });
    expect(after.generation).toBe(String(BigInt(before.generation) + 1n));
  });

  it("dedupes a mutation id that arrives over HTTP, and still rejects a malformed one", async () => {
    const httpChannel = "Q".repeat(43);
    const request = (body: Record<string, unknown>) => SELF.fetch(`https://gateway.test/v1/channels/${httpChannel}/dirty`, {
      method: "POST",
      headers: { Authorization: "Bearer gateway-test-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const first = await (await request({ mutationId: "mut_http_1", changes: [{ op: "put", path: "hub/http.md" }] })).json() as { generation: string };
    const retry = await (await request({ mutationId: "mut_http_1", changes: [{ op: "put", path: "hub/http.md" }] })).json() as { generation: string };
    expect(retry.generation).toBe(first.generation);
    expect((await request({ mutationId: "x".repeat(129) })).status).toBe(400);
  });
});

describe("Gateway HTTP transport", () => {
  it("posts the request shape the gateway already understands", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const publisher = createGatewayPublisher({
      channel: "C".repeat(43),
      url: "https://gateway.test/",
      token: "secret",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ generation: "9" });
      }) as typeof fetch,
    });

    const result = await publisher.publish({ id: "mut_http", mutationId: "mut_http", source: "mcp", op: "delete", path: "notes/x.md", committedAt: 1 });
    expect(result).toEqual({ ok: true, generation: "9" });
    expect(calls[0].url).toBe(`https://gateway.test/v1/channels/${"C".repeat(43)}/dirty`);
    expect(calls[0].authorization).toBe("Bearer secret");
    expect(calls[0].body).toMatchObject({ mutationId: "mut_http", kind: "delete", changes: [{ op: "delete", path: "notes/x.md" }] });
  });

  it("reports a disabled gateway rather than throwing", async () => {
    const publisher = createGatewayPublisher({ channel: null });
    await expect(publisher.publish({ id: "m", mutationId: "m", source: "mcp", op: "delete", path: "a.md", committedAt: 1 })).resolves.toEqual({ ok: false, kind: "disabled" });
  });
});

describe("Sync Publisher independence from the index consumer", () => {
  it("keeps the index intent when the gateway is disabled entirely", async () => {
    const { store, dependencies, recorder } = harness(createGatewayPublisher({ channel: null }));
    await recorder.record({ source: "obsidian", op: "put", path: "independence/note.md", etag: "I1", size: 1 });

    await expect(drainSyncOutbox(dependencies)).resolves.toMatchObject({ published: 0, failed: 1 });
    expect(store.snapshotIntents()).toEqual([
      expect.objectContaining({ path: "independence/note.md", action: "upsert", targetEtag: "I1", source: "obsidian" }),
    ]);
    expect(store.snapshotIntents()[0].notBefore).toBe(1_000 + OBSIDIAN_INDEX_DEBOUNCE_MS);
  });

  it("keeps the journal fact when the index consumer fails", async () => {
    const gateway = fakeGateway();
    const { journal, dependencies, recorder } = harness(gateway.publisher);
    const recorded = await recorder.record({ source: "mcp", op: "put", path: "independence/other.md", etag: "I2", size: 1 });

    // The index consumer is a separate component; here it simply never runs, which is exactly what
    // "indexing disabled" looks like from the publisher's point of view.
    await expect(drainSyncOutbox(dependencies)).resolves.toMatchObject({ published: 1 });
    await expect(journal.findByMutationId(recorded.id)).resolves.toMatchObject({ broadcastState: "published" });
  });
});

describe("VaultIndex journal contract used by the publisher", () => {
  it("persists a pending fact and its intents in the real Durable Object", async () => {
    const index = bindings().VAULT_INDEX.get(bindings().VAULT_INDEX.idFromName("vault")) as unknown as {
      resetMutationState(): Promise<void>;
      recordMutation(input: { event: unknown; intents: unknown[] }): Promise<{ inserted: boolean; seq: number }>;
      listPendingBroadcasts(limit: number): Promise<Array<{ id: string }>>;
      markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string }): Promise<void>;
    };
    await index.resetMutationState();
    const event = { id: "mut_do_publisher", source: "mcp", op: "put", path: "notes/durable.md", etag: "D1", size: 1, committedAt: 1_000 };
    await expect(index.recordMutation({ event, intents: indexIntentsFor(event as never) })).resolves.toMatchObject({ inserted: true, seq: 1 });
    await expect(index.listPendingBroadcasts(10)).resolves.toEqual([expect.objectContaining({ id: "mut_do_publisher" })]);
    await index.markBroadcast({ mutationId: "mut_do_publisher", state: "published", generation: "3" });
    await expect(index.listPendingBroadcasts(10)).resolves.toEqual([]);
  });
});
