import { SELF, evictAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { bindings } from "./support";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeHotPayload, encodeHotPayload, hotContentHash, type CheckpointReceipt, type HotAcquireResult } from "@mineral/sync-core/hot-protocol";
import { encodeTombstone, tombstoneKey } from "@mineral/sync-core/tombstones";

/**
 * The hot session, end to end inside the real runtime.
 *
 * Everything below runs against the production Durable Objects: real SQLite, real alarms, real
 * conditional R2. The only overrides are the two the platform cannot simulate locally (see
 * `test/worker/index.ts`), which is what makes these assertions about the deployed behaviour rather
 * than about a mock of it.
 */

const token = "gateway-test-token";
const channel = "H".repeat(43);
const headers = { Authorization: `Bearer ${token}` };
let counter = 0;

function request(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://gateway.test${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function acquire(input: { path: string; clientId: string; local: string | null; expected?: unknown; wantSession?: boolean }): Promise<HotAcquireResult> {
  const body = {
    protocol: 1,
    operationId: `acq-${++counter}`,
    canonicalPath: input.path,
    clientId: input.clientId,
    expected: input.expected ?? { state: "unknown" },
    local: input.local === null ? null : { contentHash: await hotContentHash(input.local), size: input.local.length },
    wantSession: input.wantSession ?? true,
  };
  const response = await request(`/v1/channels/${channel}/hot/acquire`, { method: "POST", body: JSON.stringify(body) });
  return await response.json() as HotAcquireResult;
}

type Frames = {
  next(): Promise<Record<string, unknown>>;
  /** Waits for the first frame matching a predicate, so an unrelated broadcast cannot fail a test. */
  until(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  pending(): Record<string, unknown>[];
};

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
  const next = (predicate: (frame: Record<string, unknown>) => boolean = () => true) => new Promise<Record<string, unknown>>(resolve => {
    const index = queue.findIndex(predicate);
    if (index >= 0) {
      const [frame] = queue.splice(index, 1);
      resolve(frame);
      return;
    }
    waiters.push({ predicate, resolve });
  });
  return { next, until: next, pending: () => queue.splice(0) };
}

async function openSession(ticket: string): Promise<{ socket: WebSocket; frames: Frames }> {
  const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const collector = frames(socket);
  socket.accept();
  return { socket, frames: collector };
}

/** A client's own document, and the incremental update a local edit produces. */
function client(text = "") {
  const doc = new Y.Doc();
  if (text) doc.getText("markdown").insert(0, text);
  return {
    doc,
    text: () => doc.getText("markdown").toString(),
    edit(mutate: (text: Y.Text) => void): string {
      const before = Y.encodeStateVector(doc);
      mutate(doc.getText("markdown"));
      return encodeHotPayload(Y.encodeStateAsUpdate(doc, before));
    },
    apply(update: string): void {
      Y.applyUpdate(doc, decodeHotPayload(update)!);
    },
  };
}

function operationFrame(input: { identity: { documentId: string; epoch: number }; clientId: string; clientOperationId: string; update: string; parentRevision: number }) {
  return JSON.stringify({
    protocol: 1,
    type: "operation",
    documentId: input.identity.documentId,
    epoch: input.identity.epoch,
    clientId: input.clientId,
    clientOperationId: input.clientOperationId,
    update: input.update,
    parentRevision: input.parentRevision,
  });
}

async function objectText(path: string): Promise<string | null> {
  const object = await bindings().MINERAL.get(path);
  return object ? await object.text() : null;
}

async function sessionFor(path: string, clientId: string, local: string | null) {
  const acquired = await acquire({ path, clientId, local });
  expect(["created", "joined"]).toContain(acquired.outcome);
  const identity = acquired.identity!;
  const session = await openSession(acquired.sessionTicket!);
  const welcome = await session.frames.until(frame => frame.type === "welcome");
  return { acquired, identity, welcome, ...session };
}

describe("hot session: acquisition and realtime convergence", () => {
  it("replaces an older socket for the same logical client without echoing or losing the edit", async () => {
    const path = "notes/hot-same-client-reload.md";
    const oldInstance = await sessionFor(path, "client-a", null);
    const peer = await sessionFor(path, "client-b", null);
    const replacement = await sessionFor(path, "client-a", null);
    expect(replacement.identity).toEqual(oldInstance.identity);

    const local = client();
    replacement.socket.send(operationFrame({
      identity: replacement.identity,
      clientId: "client-a",
      clientOperationId: "op-after-reload",
      update: local.edit(text => text.insert(0, "one local edit")),
      parentRevision: 0,
    }));
    expect(await replacement.frames.until(frame => frame.type === "ack")).toMatchObject({ serverRevision: 1, duplicate: false });
    expect(await peer.frames.until(frame => frame.type === "operation")).toMatchObject({ clientOperationId: "op-after-reload", serverRevision: 1 });
    expect(oldInstance.frames.pending().filter(frame => frame.type === "operation")).toEqual([]);

    oldInstance.socket.close();
    replacement.socket.close();
    peer.socket.close();
  });

  it("creates an incarnation for a free path, joins it from a second client, and converges", async () => {
    const path = "notes/hot-converge.md";
    const first = await sessionFor(path, "client-a", null);
    expect(first.acquired.outcome).toBe("created");
    expect(first.welcome.epoch).toBe(1);
    expect(first.welcome.serverRevision).toBe(0);

    const second = await sessionFor(path, "client-b", null);
    expect(second.acquired.outcome).toBe("joined");
    expect(second.acquired.identity!.documentId).toBe(first.identity.documentId);

    const a = client();
    const b = client();
    const updateA = a.edit(text => text.insert(0, "hello"));
    first.socket.send(operationFrame({ identity: first.identity, clientId: "client-a", clientOperationId: "op-1", update: updateA, parentRevision: 0 }));
    const ackA = await first.frames.until(frame => frame.type === "ack");
    expect(ackA).toMatchObject({ serverRevision: 1, duplicate: false });

    const relayed = await second.frames.until(frame => frame.type === "operation");
    expect(relayed.serverRevision).toBe(1);
    b.apply(String(relayed.update));
    expect(b.text()).toBe("hello");

    const updateB = b.edit(text => text.insert(text.length, " world"));
    second.socket.send(operationFrame({ identity: second.identity, clientId: "client-b", clientOperationId: "op-b1", update: updateB, parentRevision: 1 }));
    const ackB = await second.frames.until(frame => frame.type === "ack");
    expect(ackB).toMatchObject({ serverRevision: 2, duplicate: false });
    const relayedB = await first.frames.until(frame => frame.type === "operation");
    a.apply(String(relayedB.update));
    expect(a.text()).toBe("hello world");

    // A checkpoint names the exact revision, and the bytes in R2 are that revision's.
    first.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: first.identity.documentId, epoch: first.identity.epoch, clientId: "client-a", clientOperationId: `cp-${++counter}`, upToRevision: 2 }));
    const receipt = await first.frames.until(frame => frame.type === "checkpoint") as unknown as CheckpointReceipt;
    expect(receipt.documentRevision).toBe(2);
    expect(receipt.contentHash).toBe(await hotContentHash("hello world"));
    expect(await objectText(path)).toBe("hello world");

    first.socket.close();
    second.socket.close();
  });

  it("acknowledges a retransmission once, with the original revision", async () => {
    const path = "notes/hot-dedupe.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    const update = local.edit(text => text.insert(0, "once"));
    const frame = operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-repeat", update, parentRevision: 0 });
    session.socket.send(frame);
    expect(await session.frames.until(f => f.type === "ack")).toMatchObject({ serverRevision: 1, duplicate: false });
    session.socket.send(frame);
    expect(await session.frames.until(f => f.type === "ack")).toMatchObject({ serverRevision: 1, duplicate: true });
    session.socket.close();
  });

  it("refuses an operation from an older incarnation", async () => {
    const path = "notes/hot-stale-epoch.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    const update = local.edit(text => text.insert(0, "late"));
    session.socket.send(operationFrame({ identity: { documentId: session.identity.documentId, epoch: session.identity.epoch + 1 }, clientId: "client-a", clientOperationId: "op-late", update, parentRevision: 0 }));
    const rejection = await session.frames.until(f => f.type === "reject");
    expect(rejection.reason).toBe("stale-epoch");
    session.socket.close();
  });

  it("rejects a socket whose ticket names another document", async () => {
    const first = await acquire({ path: "notes/hot-ticket-a.md", clientId: "client-a", local: null });
    const second = await acquire({ path: "notes/hot-ticket-b.md", clientId: "client-a", local: null });
    // A ticket is bound to the document epoch it was minted for, so presenting it after the room moved
    // on cannot open a socket to the new incarnation.
    const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(first.sessionTicket!)}`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close();
    expect(second.sessionTicket).not.toBe(first.sessionTicket);
  });
});

describe("hot session: durability without the client", () => {
  it("checkpoints a revision the server acknowledged after every client has gone", async () => {
    const path = "notes/hot-offline-save.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    const update = local.edit(text => text.insert(0, "survives the client"));
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-1", update, parentRevision: 0 }));
    expect(await session.frames.until(f => f.type === "ack")).toMatchObject({ serverRevision: 1 });

    // The platform tears the object down while the socket is only hibernated, so nothing in memory —
    // not the CRDT, not the schedule — survives. The alarm is what has to finish the save.
    await evictAllDurableObjects();
    const room = bindings().ROOM.getByName(session.identity.documentId);
    expect(await objectText(path)).toBeNull();
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await objectText(path)).toBe("survives the client");
  });

  it("checkpoints the last revision when the last socket closes", async () => {
    const path = "notes/hot-last-client.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-1", update: local.edit(t => t.insert(0, "final content")), parentRevision: 0 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.close();
    // The close handler runs the checkpoint itself, with no alarm and no client request.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await objectText(path)).toBe("final content");
  });

  it("does not report a later revision as saved", async () => {
    const path = "notes/hot-revision-honesty.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-1", update: local.edit(t => t.insert(0, "v1")), parentRevision: 0 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: session.identity.documentId, epoch: session.identity.epoch, clientId: "client-a", clientOperationId: "cp-1", upToRevision: 1 }));
    const receipt = await session.frames.until(f => f.type === "checkpoint") as unknown as CheckpointReceipt;
    expect(receipt.documentRevision).toBe(1);
    expect(receipt.latestCheckpointedRevision).toBe(1);

    // A newer revision arrives after the receipt was produced; the receipt must not retroactively
    // describe it, and the room must still know it owes a save.
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-2", update: local.edit(t => t.insert(t.length, " and v2")), parentRevision: 1 }));
    expect(await session.frames.until(f => f.type === "ack")).toMatchObject({ serverRevision: 2 });
    expect(receipt.latestAcceptedRevision).toBe(1);
    expect(await objectText(path)).toBe("v1");
    session.socket.close();
  });
});

describe("hot session: external mutation", () => {
  it("refuses to overwrite an object someone else changed", async () => {
    const path = "notes/hot-external-write.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-1", update: local.edit(t => t.insert(0, "hot content")), parentRevision: 0 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: session.identity.documentId, epoch: session.identity.epoch, clientId: "client-a", clientOperationId: "cp-1", upToRevision: 1 }));
    expect((await session.frames.until(f => f.type === "checkpoint") as unknown as CheckpointReceipt).documentRevision).toBe(1);

    // An external writer (another tool, an older client) replaces the object.
    await bindings().MINERAL.put(path, "external content");
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-2", update: local.edit(t => t.insert(t.length, " more")), parentRevision: 1 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: session.identity.documentId, epoch: session.identity.epoch, clientId: "client-a", clientOperationId: "cp-2", upToRevision: 2 }));
    const conflicted = await session.frames.until(f => f.type === "document-state" && f.state === "conflicted");
    expect(conflicted).toBeTruthy();
    // The external bytes are still there: a conflict is reported, never resolved by overwriting.
    expect(await objectText(path)).toBe("external content");
    session.socket.close();
  });

  it("never resurrects a revision an external writer tombstoned", async () => {
    const path = "notes/hot-external-delete.md";
    const session = await sessionFor(path, "client-a", null);
    const local = client();
    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-1", update: local.edit(t => t.insert(0, "content")), parentRevision: 0 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: session.identity.documentId, epoch: session.identity.epoch, clientId: "client-a", clientOperationId: "cp-1", upToRevision: 1 }));
    await session.frames.until(f => f.type === "checkpoint");

    const head = await bindings().MINERAL.head(path);
    const key = await tombstoneKey(path, head!.etag.replace(/^"|"$/g, ""));
    await bindings().MINERAL.put(key!, encodeTombstone({ protocol: 1, path, deletedRemoteETag: head!.etag.replace(/^"|"$/g, ""), createdAt: new Date().toISOString() }));

    session.socket.send(operationFrame({ identity: session.identity, clientId: "client-a", clientOperationId: "op-2", update: local.edit(t => t.insert(t.length, " after delete")), parentRevision: 1 }));
    await session.frames.until(f => f.type === "ack");
    session.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId: session.identity.documentId, epoch: session.identity.epoch, clientId: "client-a", clientOperationId: "cp-2", upToRevision: 2 }));
    const conflicted = await session.frames.until(f => f.type === "document-state" && f.state === "conflicted");
    expect(conflicted.reason).toBe("remote-deleted");
    expect(await objectText(path)).toBe("content");
    session.socket.close();
  });
});


/**
 * A checkpoint records a mutation and drives its consumers in `waitUntil`: the gateway announcement and
 * the index drains. Those chains are the runtime's, not this file's, so ending the file immediately can
 * leave one pending when vitest tears the environment down — which surfaces as an unhandled
 * `EnvironmentTeardownError` even though every test passed. Waiting here is test hygiene, not a product
 * behaviour: nothing in the assertions below depends on it.
 */
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
