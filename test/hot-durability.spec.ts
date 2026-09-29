import { SELF, evictAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeHotPayload, hotContentHash, type CheckpointReceipt, type HotAcquireResult } from "@mineral/sync-core/hot-protocol";
import { bindings, hotRoom, vaultHotEntrypoint } from "./support";
import type { MutationJournal } from "../apps/vault/src/mutation/store";

/**
 * The two failures a hot checkpoint has to survive rather than report as success.
 *
 * 1. **R2 is unavailable.** The room must keep the target, keep retrying, and keep saying the save is
 *    pending — never that it landed.
 * 2. **The response to a successful write is lost.** The retry must *recognise its own commit* in the
 *    object it already wrote, instead of failing a precondition or writing a second time.
 *
 * Both are invisible to a happy-path test, and both are precisely the states a real outage produces.
 */

const token = "gateway-test-token";
const channel = "R".repeat(43);
const headers = { Authorization: `Bearer ${token}` };
let counter = 0;

function request(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://gateway.test${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function acquire(path: string, clientId: string): Promise<HotAcquireResult> {
  const response = await request(`/v1/channels/${channel}/hot/acquire`, {
    method: "POST",
    body: JSON.stringify({ protocol: 1, operationId: `acq-${++counter}`, canonicalPath: path, clientId, expected: { state: "unknown" }, local: null, wantSession: true }),
  });
  return await response.json() as HotAcquireResult;
}

type Frames = { until(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> };

function frames(socket: WebSocket): Frames {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(frame);
      return;
    }
    queue.push(frame);
  });
  return {
    until: predicate => new Promise(resolve => {
      const index = queue.findIndex(predicate);
      if (index >= 0) {
        const [frame] = queue.splice(index, 1);
        resolve(frame);
        return;
      }
      waiters.push({ predicate, resolve });
    }),
  };
}

async function openSession(ticket: string): Promise<{ socket: WebSocket; frames: Frames }> {
  const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const collector = frames(socket);
  socket.accept();
  await collector.until(frame => frame.type === "welcome");
  return { socket, frames: collector };
}

function editFrame(documentId: string, epoch: number, clientId: string, clientOperationId: string, text: string) {
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, text);
  return JSON.stringify({ protocol: 1, type: "operation", documentId, epoch, clientId, clientOperationId, update: encodeHotPayload(Y.encodeStateAsUpdate(doc)), parentRevision: 0 });
}

async function objectText(path: string): Promise<string | null> {
  const object = await bindings().MINERAL.get(path);
  return object ? await object.text() : null;
}

describe("hot durability under failure", () => {
  it("keeps the target, keeps saying pending, and lands the save when R2 recovers", async () => {
    const path = "notes/durability-outage.md";
    const acquired = await acquire(path, "client-a");
    expect(acquired.outcome).toBe("created");
    const identity = acquired.identity!;
    const session = await openSession(acquired.sessionTicket!);
    const room = hotRoom(identity.documentId);

    session.socket.send(editFrame(identity.documentId, identity.epoch, "client-a", "op-1", "survives the outage\n"));
    expect((await session.frames.until(frame => frame.type === "ack")).serverRevision).toBe(1);

    // R2 is down for exactly one attempt.
    await room.failNextCheckpoints(1);
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "cp-1", upToRevision: 1 }));
    const answer = await session.frames.until(frame => frame.type === "checkpoint" || frame.type === "document-state");
    expect(answer.type).toBe("document-state");
    expect(String(answer.reason)).toContain("r2 unavailable");
    expect(await objectText(path)).toBeNull();

    // The revision is acknowledged, unsaved, and the target is durable — the three facts a client needs.
    const afterFailure = await room.describe();
    expect(afterFailure).toMatchObject({ latestAcceptedRevision: 1, latestCheckpointedRevision: 0, pendingSave: true, state: "active" });

    // The retry the room scheduled itself is what finishes the job: no client asks again.
    session.socket.close();
    expect(await runDurableObjectAlarm(room)).toBe(true);
    const receipt = await room.lastReceipt();
    expect(receipt?.documentRevision).toBe(1);
    expect(receipt?.contentHash).toBe(await hotContentHash("survives the outage\n"));
    expect(await objectText(path)).toBe("survives the outage\n");
    expect((await room.describe())?.pendingSave).toBe(false);
  });

  it("recognises its own commit instead of rewriting when the response was lost", async () => {
    const path = "notes/durability-lost-response.md";
    await bindings().MINERAL.put(path, "base\n");
    const head = await bindings().MINERAL.head(path);
    const baseETag = head!.etag.replace(/^"|"$/g, "");
    const markdown = "next revision\n";
    const input = {
      canonicalPath: path,
      documentId: "AbCdEfGhIjKlMnOpQrStUv",
      epoch: 1,
      documentRevision: 2,
      commitId: "commit-lost-response-1",
      contentHash: await hotContentHash(markdown),
      markdown,
      expectedRemoteETag: baseETag,
      replaceTombstonedRevision: false,
    };

    const first = await vaultHotEntrypoint().checkpointHotDocument(input);
    expect(first.status).toBe("committed");
    if (first.status !== "committed") throw new Error("unreachable");
    expect(first.recovered).toBe(false);

    // Same commit, same expectation: the caller never learned that the first write landed.
    const retry = await vaultHotEntrypoint().checkpointHotDocument(input);
    expect(retry.status).toBe("committed");
    if (retry.status !== "committed") throw new Error("unreachable");
    expect(retry.recovered).toBe(true);
    expect(retry.etag).toBe(first.etag);
    expect(await objectText(path)).toBe(markdown);

    // Exactly one fact: a recovered commit is not a second mutation.
    const found = await (bindings().VAULT_INDEX.get(bindings().VAULT_INDEX.idFromName("vault")) as unknown as MutationJournal).findByMutationId("commit-lost-response-1");
    expect(found?.seq).toBe(first.mutationSeq);
  });

  it("recognises its own rename instead of failing on the target it already wrote", async () => {
    const from = "notes/durability-move-from.md";
    const to = "notes/durability-move-to.md";
    await bindings().MINERAL.put(from, "move me\n");
    const head = await bindings().MINERAL.head(from);
    const sourceETag = head!.etag.replace(/^"|"$/g, "");
    const markdown = "move me\n";
    const input = {
      fromPath: from,
      toPath: to,
      documentId: "AbCdEfGhIjKlMnOpQrStUv",
      epoch: 3,
      documentRevision: 4,
      commitId: "commit-lost-response-move",
      contentHash: await hotContentHash(markdown),
      markdown,
      expectedFromETag: sourceETag,
    };

    const first = await vaultHotEntrypoint().moveHotDocument(input);
    expect(first.status).toBe("moved");
    const retry = await vaultHotEntrypoint().moveHotDocument(input);
    expect(retry.status).toBe("moved");
    if (retry.status !== "moved") throw new Error("unreachable");
    expect(await objectText(to)).toBe(markdown);
    // The source is tombstoned exactly once, and the retry did not overwrite the new path with a
    // second generation of bytes.
    const journal = bindings().VAULT_INDEX.get(bindings().VAULT_INDEX.idFromName("vault")) as unknown as MutationJournal;
    expect((await journal.findByMutationId("commit-lost-response-move.to"))?.op).toBe("put");
    expect((await journal.findByMutationId("commit-lost-response-move.from"))?.op).toBe("delete");
  });

  it("arms its own checkpoint alarm after an edit, so the save does not depend on the client", async () => {
    // §38.3's second half, observed rather than calculated: after an operation is acked the room must
    // already have a save scheduled. If it did not, a device that never closes the file cleanly would
    // keep its content only in the CRDT log.
    const path = "notes/durability-schedule.md";
    const acquired = await acquire(path, "client-a");
    const identity = acquired.identity!;
    const session = await openSession(acquired.sessionTicket!);
    const room = hotRoom(identity.documentId);
    expect((await room.storageStats())?.alarmAt).toBeNull();

    const doc = new Y.Doc();
    doc.getText("markdown").insert(0, "scheduled\n");
    const before = Date.now();
    session.socket.send(JSON.stringify({ protocol: 1, type: "operation", documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "op-schedule", update: encodeHotPayload(Y.encodeStateAsUpdate(doc)), parentRevision: 0 }));
    await session.frames.until(frame => frame.type === "ack");

    const stats = await room.storageStats();
    expect(stats?.alarmAt, "an acked operation must leave a scheduled save behind").not.toBeNull();
    // The debounce is two seconds; allow for the test's own latency without allowing "much later".
    expect(stats!.alarmAt! - before).toBeLessThanOrEqual(2_500);
    expect(stats!.alarmAt! - before).toBeGreaterThan(0);
    session.socket.close();
  });

  it("folds a long operation log into the snapshot without losing the document", async () => {
    // Compaction is the one place a durable log is deliberately discarded, so it needs its own test: the
    // room must fold exactly the revisions R2 already has, and a crash after folding must still
    // materialize every byte.
    const path = "notes/durability-compaction.md";
    const acquired = await acquire(path, "client-a");
    const identity = acquired.identity!;
    const session = await openSession(acquired.sessionTicket!);
    const room = hotRoom(identity.documentId);

    // 300 operations, one digit each: comfortably past the fold threshold, and individually cheap.
    const operations = 300;
    for (let index = 0; index < operations; index++) {
      const doc = new Y.Doc();
      doc.getText("markdown").insert(0, String(index % 10));
      session.socket.send(JSON.stringify({ protocol: 1, type: "operation", documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: `op-${index}`, update: encodeHotPayload(Y.encodeStateAsUpdate(doc)), parentRevision: index }));
    }
    const lastAck = await session.frames.until(frame => frame.type === "ack" && frame.serverRevision === operations);
    expect(lastAck.serverRevision).toBe(operations);

    const beforeFold = await room.storageStats();
    // Every operation is acknowledged and durable; how much of the log is still unfolded depends on
    // whether the room's own debounced alarm fired during the burst — which it may well have, because a
    // bounded checkpoint delay is exactly what the room is supposed to do. Asserting "the snapshot is
    // behind" here would be asserting that the alarm did *not* work.
    expect(beforeFold?.latestAcceptedRevision).toBe(operations);
    expect(beforeFold?.operations).toBeGreaterThan(0);

    // One checkpoint covers all of them, which is exactly what makes the log foldable.
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "cp-fold", upToRevision: operations }));
    const receipt = await session.frames.until(frame => frame.type === "checkpoint") as unknown as CheckpointReceipt;
    expect(receipt.documentRevision).toBe(operations);

    const afterFold = await room.storageStats();
    expect(afterFold?.snapshotRevision).toBe(operations);
    expect(afterFold?.operations).toBe(0);
    expect(receipt.contentHash).toBe(await hotContentHash((await objectText(path)) ?? ""));

    // A crash after folding must still rebuild every byte — now from the snapshot alone.
    await evictAllDurableObjects();
    expect((await room.describe())?.latestAcceptedRevision).toBe(operations);
    expect((await room.storageStats())?.snapshotRevision).toBe(operations);

    // And the document keeps working: the next edit lands at the next revision.
    const next = new Y.Doc();
    next.getText("markdown").insert(0, "!");
    session.socket.send(JSON.stringify({ protocol: 1, type: "operation", documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "op-after-fold", update: encodeHotPayload(Y.encodeStateAsUpdate(next)), parentRevision: operations }));
    const afterAck = await session.frames.until(frame => frame.type === "ack" && frame.clientOperationId === "op-after-fold");
    expect(afterAck.serverRevision).toBe(operations + 1);
    session.socket.close();
    // 300 durable operations, each with a storage read for the alarm schedule: the heaviest test in the
    // suite on purpose, so it gets a budget of its own instead of the default five seconds.
  }, 30_000);
});



/**
 * A checkpoint records a mutation and drives its consumers in `waitUntil`: the gateway announcement and
 * the index drains. Those chains are the runtime's, not this file's, so ending the file immediately can
 * leave one pending when vitest tears the environment down — which surfaces as an unhandled
 * `EnvironmentTeardownError` even though every test passed. Waiting here is test hygiene, not a product
 * behaviour: nothing in the assertions below depends on it.
 */
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 1_000)); });



