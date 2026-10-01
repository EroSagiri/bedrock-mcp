import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { bindings } from "./support";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeHotPayload, encodeHotPayload, hotContentHash, type CheckpointReceipt, type ColdAuthorityResult, type HotAcquireResult, type PathBinding } from "@mineral/sync-core/hot-protocol";
import type { NamespaceResult } from "@mineral/sync-core/namespace-protocol";
import { TOMBSTONE_NAMESPACE, tombstoneKey } from "@mineral/sync-core/tombstones";

/**
 * Namespace lifecycle: create, delete, rename, and the fence that makes them safe.
 *
 * These are the operations that cannot be expressed as document content. A deletion is not an empty
 * file, a rename is not a new document, and both must survive a crash halfway through — which is why
 * most assertions here are about *bindings, epochs, and tombstones* rather than about text.
 */

const token = "gateway-test-token";
const channel = "N".repeat(43);
const headers = { Authorization: `Bearer ${token}` };
let counter = 0;

function request(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://gateway.test${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function acquire(input: { path: string; clientId: string; local: string | null; expected?: unknown }): Promise<HotAcquireResult> {
  const body = {
    protocol: 1,
    operationId: `acq-${++counter}`,
    canonicalPath: input.path,
    clientId: input.clientId,
    expected: input.expected ?? { state: "unknown" },
    local: input.local === null ? null : { contentHash: await hotContentHash(input.local), size: input.local.length },
    wantSession: true,
  };
  const response = await request(`/v1/channels/${channel}/hot/acquire`, { method: "POST", body: JSON.stringify(body) });
  return await response.json() as HotAcquireResult;
}

type Frames = {
  until(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
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

async function openSession(ticket: string): Promise<{ socket: WebSocket; frames: Frames; crdtState: string }> {
  const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const collector = frames(socket);
  socket.accept();
  const welcome = await collector.until(frame => frame.type === "welcome");
  return { socket, frames: collector, crdtState: String(welcome.crdtState) };
}

/**
 * A client holding the room's CRDT state.
 *
 * Every update is a **full** encoded state rather than a delta: a delta needs the receiver's state
 * vector to be right, and a client that guesses it wrong produces an update whose dependencies are
 * missing, which Yjs holds as a pending struct instead of integrating. Full states are idempotent and
 * always self-contained, which is what a test wants; a real client tracks the server's revision and
 * may send deltas.
 */
type TestClient = {
  text(): string;
  update(mutate: (body: Y.Text) => void): string;
  fork(): TestClient;
};

function clientFrom(crdtState: string): TestClient {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decodeHotPayload(crdtState)!);
  return {
    text: () => doc.getText("markdown").toString(),
    update(mutate: (body: Y.Text) => void): string {
      mutate(doc.getText("markdown"));
      return encodeHotPayload(Y.encodeStateAsUpdate(doc));
    },
    /** An independent client from the same state, for the "this edit was refused" cases. */
    fork(): TestClient {
      return clientFrom(encodeHotPayload(Y.encodeStateAsUpdate(doc)));
    },
  };
}

function editFrame(input: { documentId: string; epoch: number; clientId: string; clientOperationId: string; update: string; parentRevision: number }) {
  return JSON.stringify({
    protocol: 1,
    type: "operation",
    documentId: input.documentId,
    epoch: input.epoch,
    clientId: input.clientId,
    clientOperationId: input.clientOperationId,
    update: input.update,
    parentRevision: input.parentRevision,
  });
}

function checkpointFrame(documentId: string, epoch: number, clientId: string, upToRevision: number) {
  return JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId, epoch, clientId, clientOperationId: `cp-${++counter}`, upToRevision });
}

/** Binds a path, writes content, and checkpoints it: the state every lifecycle operation starts from. */
async function hotPathWithContent(path: string, clientId: string, text: string) {
  const acquired = await acquire({ path, clientId, local: null });
  expect(acquired.outcome).toBe("created");
  const identity = acquired.identity!;
  const session = await openSession(acquired.sessionTicket!);
  const local = clientFrom(session.crdtState);
  session.socket.send(editFrame({ documentId: identity.documentId, epoch: identity.epoch, clientId, clientOperationId: `op-${++counter}`, update: local.update(body => body.insert(0, text)), parentRevision: 0 }));
  const ack = await session.frames.until(frame => frame.type === "ack");
  expect(ack.serverRevision).toBe(1);
  session.socket.send(checkpointFrame(identity.documentId, identity.epoch, clientId, 1));
  const receipt = await session.frames.until(frame => frame.type === "checkpoint" && frame.documentRevision === 1) as unknown as CheckpointReceipt;
  return { identity, session, local, receipt, binding: acquired.binding! };
}

async function namespace(body: Record<string, unknown>): Promise<{ status: number; result: NamespaceResult }> {
  const response = await request(`/v1/channels/${channel}/hot/namespace`, { method: "POST", body: JSON.stringify({ protocol: 1, ...body }) });
  return { status: response.status, result: await response.json() as NamespaceResult };
}

async function pathStatus(path: string): Promise<{ binding: PathBinding | null; hotOwned: boolean; remote: { exists: boolean; etag: string | null; deleted: boolean } | null }> {
  return await (await request(`/v1/channels/${channel}/hot/path?path=${encodeURIComponent(path)}`)).json() as never;
}

async function objectText(path: string): Promise<string | null> {
  const object = await bindings().MINERAL.get(path);
  return object ? await object.text() : null;
}

async function tombstoneExists(path: string, etag: string): Promise<boolean> {
  const key = await tombstoneKey(path, etag);
  if (!key) return false;
  return (await bindings().MINERAL.head(key)) !== null;
}

/** Waits for a condition that another Durable Object settles asynchronously. */
async function waitFor(check: () => Promise<boolean>, attempts = 20): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return check();
}

describe("namespace: create", () => {
  it("binds a free path once, and refuses a concurrent second create", async () => {
    const path = "notes/ns-create.md";
    const first = await namespace({ type: "create", operationId: "create-1", clientId: "client-a", canonicalPath: path, expectedPathState: { state: "absent" }, local: null });
    expect(first.result.outcome).toBe("applied");
    expect(first.result.binding?.state).toBe("active");
    expect(first.result.identity?.epoch).toBe(1);

    const second = await namespace({ type: "create", operationId: "create-2", clientId: "client-b", canonicalPath: path, expectedPathState: { state: "absent" }, local: null });
    expect(second.result.outcome).toBe("conflict");
    expect(second.result.reason).toBe("path-taken");
    // The winner is untouched by the loser.
    expect(second.result.binding?.documentId).toBe(first.result.binding?.documentId);

    // A settled operation is answered from its own record rather than executed twice.
    const replay = await namespace({ type: "create", operationId: "create-1", clientId: "client-a", canonicalPath: path, expectedPathState: { state: "absent" }, local: null });
    expect(replay.result.outcome).toBe("applied");
    expect(replay.result.binding?.documentId).toBe(first.result.binding?.documentId);
  });

  it("keeps one incarnation across acquisitions that were never followed by a socket", async () => {
    // Two devices open the same file in quick succession. Neither has connected yet, nothing has been
    // checkpointed, and R2 is empty — which is *consistent* with the incarnation, not evidence against
    // it. Minting a second document here would silently fork the file into two histories.
    const path = "notes/ns-create-no-socket.md";
    const first = await acquire({ path, clientId: "client-a", local: null });
    const second = await acquire({ path, clientId: "client-b", local: null });
    const third = await acquire({ path, clientId: "client-a", local: null, expected: { state: "bound", documentId: first.identity!.documentId, epoch: first.identity!.epoch } });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("joined");
    expect(second.identity!.documentId).toBe(first.identity!.documentId);
    expect(third.outcome).toBe("joined");
  });

  it("adopts an object that appeared after a path was bound but never published", async () => {    // The path was free when it was bound; an external writer creates it before this incarnation has
    // checkpointed anything. R2 now holds content the room has never seen, so the room may not simply
    // continue as if nothing happened.
    const path = "notes/ns-create-external.md";
    const first = await acquire({ path, clientId: "client-a", local: null });
    expect(first.outcome).toBe("created");
    await bindings().MINERAL.put(path, "external content");
    const second = await acquire({ path, clientId: "client-b", local: "external content" });
    expect(second.outcome).toBe("created");
    expect(second.identity!.documentId).not.toBe(first.identity!.documentId);
    expect(second.remote?.etag).toBeTruthy();
  });

  it("treats an empty object as content, not as an absence", async () => {
    // A zero-byte object is a legitimate revision — a file the user emptied. Testing the fetched content
    // for truthiness made every such path answer "unavailable" forever, which a client can only present as
    // a conflict no decision can settle. This is that regression, pinned.
    const path = "notes/ns-empty-object.md";
    await bindings().MINERAL.put(path, "");
    const first = await acquire({ path, clientId: "client-a", local: "" });
    expect(first.outcome).toBe("created");
    expect(first.remote?.size).toBe(0);
    // And a device that holds content for that path gets the honest answer: the versions disagree.
    const second = await acquire({ path, clientId: "client-b", local: "local text\n" });
    expect(second.outcome).toBe("conflict");
    expect(second.reason).toBe("local-remote-mismatch");
  });

  it("admits a device whose local file is empty, because it has nothing to protect", async () => {
    // The shape that trapped a real device: the document held content, the other device's file was still
    // empty (it had never received the content), and the join was refused as a mismatch — a conflict the
    // user could only clear by hand, for a file with no content of its own at all.
    const path = "notes/ns-empty-local-joins.md";
    const creator = await acquire({ path, clientId: "client-a", local: "document text\n" });
    expect(creator.outcome).toBe("created");
    const empty = await acquire({ path, clientId: "client-b", local: "" });
    expect(empty.outcome).toBe("joined");
    // Content that actually disagrees is still refused: the rule is about emptiness, not about caution.
    const different = await acquire({ path, clientId: "client-c", local: "something else\n" });
    expect(different.outcome).toBe("conflict");
    expect(different.reason).toBe("local-remote-mismatch");
  });

  it("refuses an operation id that names a different intent", async () => {
    // An operation id is caller-chosen, so two different intents can carry the same one — a recycled
    // counter, a copy-pasted client. Answering with the first intent's result would report a rename
    // against a path the caller never named, which is why identity is checked before the replay.
    const pathA = "notes/ns-intent-collision-a.md";
    const pathB = "notes/ns-intent-collision-b.md";
    const first = await namespace({ type: "create", operationId: "collide-1", clientId: "client-a", canonicalPath: pathA, expectedPathState: { state: "absent" }, local: null });
    expect(first.result.outcome).toBe("applied");
    const colliding = await namespace({ type: "create", operationId: "collide-1", clientId: "client-a", canonicalPath: pathB, expectedPathState: { state: "absent" }, local: null });
    expect(colliding.result.outcome).toBe("conflict");
    expect(colliding.result.reason).toBe("stale-intent");
    // The second path was not created, and the first path's binding is untouched.
    expect((await pathStatus(pathB)).binding).toBeNull();
    expect((await pathStatus(pathA)).binding?.documentId).toBe(first.result.binding?.documentId);
  });
});

describe("namespace: delete", () => {
  it("checkpoints, tombstones the exact revision, retires the epoch, and refuses the old epoch afterwards", async () => {
    const path = "notes/ns-delete.md";
    const { identity, session, local, receipt } = await hotPathWithContent(path, "client-a", "to be deleted");

    const deletion = await namespace({
      type: "delete",
      operationId: "delete-1",
      clientId: "client-a",
      canonicalPath: path,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch,
      expectedRemoteETag: receipt.r2ETag,
      expectedDocumentRevision: receipt.documentRevision,
    });
    expect(deletion.result.outcome).toBe("applied");
    expect(deletion.result.binding?.state).toBe("deleted");
    expect(deletion.result.binding?.documentId).toBe(identity.documentId);
    // The object stays; the deletion is the tombstone that retires its exact revision.
    expect(await objectText(path)).toBe("to be deleted");
    expect(await tombstoneExists(path, receipt.r2ETag!)).toBe(true);
    const status = await pathStatus(path);
    expect(status.remote?.deleted).toBe(true);
    expect(status.remote?.exists).toBe(false);

    // A late operation from the retired incarnation cannot reach anything.
    session.socket.send(editFrame({ documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "op-late", update: local.fork().update(body => body.insert(body.length, " resurrect")), parentRevision: 1 }));
    const rejection = await session.frames.until(frame => frame.type === "reject" || frame.type === "document-state");
    expect(["reject", "document-state"]).toContain(rejection.type);
    expect(await objectText(path)).toBe("to be deleted");
    session.socket.close();
  });

  it("refuses a delete against a stale epoch", async () => {
    const path = "notes/ns-delete-stale.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "content");
    const deletion = await namespace({
      type: "delete",
      operationId: "delete-stale",
      clientId: "client-a",
      canonicalPath: path,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch + 5,
      expectedRemoteETag: null,
      expectedDocumentRevision: null,
    });
    expect(deletion.result.outcome).toBe("conflict");
    expect(deletion.result.reason).toBe("stale-epoch");
    expect(await objectText(path)).toBe("content");
    session.socket.close();
  });
});

describe("namespace: rename", () => {
  it("keeps the document, bumps the epoch, and moves the path", async () => {
    const from = "notes/ns-rename-from.md";
    const to = "notes/ns-rename-to.md";
    const { identity, session, local, receipt } = await hotPathWithContent(from, "client-a", "moved content");

    const rename = await namespace({
      type: "rename",
      operationId: "rename-1",
      clientId: "client-a",
      fromPath: from,
      toPath: to,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch,
      expectedFromBinding: { documentId: identity.documentId, epoch: identity.epoch },
      expectedToPathState: { state: "absent" },
    });
    expect(rename.result.outcome).toBe("applied");
    expect(rename.result.identity).toEqual({ documentId: identity.documentId, epoch: 2 });
    expect(rename.result.binding?.canonicalPath).toBe(to);
    expect(rename.result.binding?.state).toBe("active");
    expect(rename.result.fromBinding?.state).toBe("deleted");

    expect(await objectText(to)).toBe("moved content");
    expect(await tombstoneExists(from, receipt.r2ETag!)).toBe(true);
    expect((await pathStatus(from)).remote?.deleted).toBe(true);
    expect((await pathStatus(to)).binding?.epoch).toBe(2);

    const renamed = await session.frames.until(frame => frame.type === "document-state" && frame.state === "active");
    expect(renamed).toMatchObject({ documentId: identity.documentId, epoch: 2, canonicalPath: to, reason: "renamed" });

    // The old epoch is refused: a packet from before the rename cannot land in the new incarnation.
    session.socket.send(editFrame({ documentId: identity.documentId, epoch: identity.epoch, clientId: "client-a", clientOperationId: "op-old-epoch", update: local.fork().update(body => body.insert(body.length, " late")), parentRevision: 1 }));
    expect((await session.frames.until(frame => frame.type === "reject")).reason).toBe("stale-epoch");

    // The same document continues at the new epoch, and its next checkpoint lands at the new path.
    session.socket.send(editFrame({ documentId: identity.documentId, epoch: 2, clientId: "client-a", clientOperationId: "op-new-epoch", update: local.update(body => body.insert(body.length, " appended")), parentRevision: 1 }));
    expect((await session.frames.until(frame => frame.type === "ack")).serverRevision).toBe(2);
    session.socket.send(checkpointFrame(identity.documentId, 2, "client-a", 2));
    const receipt2 = await session.frames.until(frame => frame.type === "checkpoint" && frame.documentRevision === 2);
    expect(receipt2.contentHash).toBe(await hotContentHash("moved content appended"));
    expect(await objectText(to)).toBe("moved content appended");
    session.socket.close();
  });

  it("refuses to overwrite an existing target", async () => {
    const from = "notes/ns-rename-clash-from.md";
    const to = "notes/ns-rename-clash-to.md";
    const { identity, session } = await hotPathWithContent(from, "client-a", "source content");
    const target = await hotPathWithContent(to, "client-b", "target content");

    const rename = await namespace({
      type: "rename",
      operationId: "rename-clash",
      clientId: "client-a",
      fromPath: from,
      toPath: to,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch,
      expectedFromBinding: { documentId: identity.documentId, epoch: identity.epoch },
      expectedToPathState: { state: "absent" },
    });
    expect(rename.result.outcome).toBe("conflict");
    expect(rename.result.reason).toBe("target-exists");
    // Neither side was touched.
    expect(await objectText(to)).toBe("target content");
    expect(await objectText(from)).toBe("source content");
    expect((await pathStatus(to)).binding?.documentId).toBe(target.identity.documentId);
    session.socket.close();
    target.session.socket.close();
  });

  it("refuses a rename whose source binding has changed", async () => {
    const from = "notes/ns-rename-stale.md";
    const to = "notes/ns-rename-stale-target.md";
    const { identity, session } = await hotPathWithContent(from, "client-a", "content");
    const rename = await namespace({
      type: "rename",
      operationId: "rename-stale",
      clientId: "client-a",
      fromPath: from,
      toPath: to,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch + 3,
      expectedFromBinding: { documentId: identity.documentId, epoch: identity.epoch + 3 },
      expectedToPathState: { state: "absent" },
    });
    expect(rename.result.outcome).toBe("conflict");
    expect(rename.result.reason).toBe("stale-epoch");
    session.socket.close();
  });
});

describe("namespace: recreate after delete", () => {
  it("mints a new incarnation whose content the old tombstone does not hide", async () => {
    const path = "notes/ns-recreate.md";
    const first = await hotPathWithContent(path, "client-a", "first life");
    const deletion = await namespace({
      type: "delete",
      operationId: "recreate-delete",
      clientId: "client-a",
      canonicalPath: path,
      documentId: first.identity.documentId,
      expectedEpoch: first.identity.epoch,
      expectedRemoteETag: first.receipt.r2ETag,
      expectedDocumentRevision: first.receipt.documentRevision,
    });
    expect(deletion.result.outcome).toBe("applied");
    first.session.socket.close();

    // Recreating the path is a new document, not a resurrection of the old one.
    const recreated = await acquire({ path, clientId: "client-c", local: null });
    expect(recreated.outcome).toBe("created");
    expect(recreated.identity!.documentId).not.toBe(first.identity.documentId);

    const session = await openSession(recreated.sessionTicket!);
    const local = clientFrom(session.crdtState);
    session.socket.send(editFrame({ documentId: recreated.identity!.documentId, epoch: 1, clientId: "client-c", clientOperationId: "op-new-life", update: local.update(body => body.insert(0, "second life")), parentRevision: 0 }));
    expect((await session.frames.until(frame => frame.type === "ack")).serverRevision).toBe(1);
    session.socket.send(checkpointFrame(recreated.identity!.documentId, 1, "client-c", 1));
    const receipt = await session.frames.until(frame => frame.type === "checkpoint") as unknown as CheckpointReceipt;
    expect(receipt.contentHash).toBe(await hotContentHash("second life"));

    // The replacement is a different object revision, so the old tombstone still describes only the
    // revision it retired and the new file is visible.
    expect(await objectText(path)).toBe("second life");
    const status = await pathStatus(path);
    expect(status.remote?.exists).toBe(true);
    expect(status.remote?.deleted).toBe(false);
    expect(status.binding?.documentId).toBe(recreated.identity!.documentId);
    session.socket.close();
  });
});

describe("cold-mutation authority", () => {
  async function coldAcquire(path: string, expectedRemoteETag: string | null): Promise<ColdAuthorityResult & { operationId: string }> {
    const operationId = `cold-${++counter}`;
    const response = await request(`/v1/channels/${channel}/hot/cold/acquire`, {
      method: "POST",
      body: JSON.stringify({ protocol: 1, operationId, operation: "put", canonicalPath: path, clientId: "cold-writer", expectedRemoteETag }),
    });
    return { ...(await response.json() as ColdAuthorityResult), operationId };
  }

  it("denies a cold write while a hot session owns the path, and grants it after release", async () => {
    const path = "notes/ns-cold-lease.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "hot content");

    const denied = await coldAcquire(path, null);
    expect(denied.outcome).toBe("denied");
    expect(denied.reason).toBe("hot-owned");

    // The client leaves deliberately and asks for a checkpoint covering what it acked.
    const released = await (await request(`/v1/channels/${channel}/hot/release`, {
      method: "POST",
      body: JSON.stringify({ protocol: 1, operationId: "release-1", clientId: "client-a", documentId: identity.documentId, epoch: identity.epoch, checkpoint: true, lastAcceptedRevision: 1 }),
    })).json() as { outcome: string };
    expect(["released", "checkpoint-pending"]).toContain(released.outcome);

    // Closing the last socket is what hands the path back: nobody is holding it, and no save is owed.
    session.socket.close();
    expect(await waitFor(async () => !(await pathStatus(path)).hotOwned)).toBe(true);

    const granted = await coldAcquire(path, null);
    expect(granted.outcome).toBe("granted");
    expect(granted.token).toBeTruthy();

    const commit = await (await request(`/v1/channels/${channel}/hot/cold/commit`, {
      method: "POST",
      body: JSON.stringify({ protocol: 1, token: granted.token, operationId: granted.operationId, clientId: "cold-writer", operation: "put", canonicalPath: path, etag: "etag-after-cold-write", size: 3, committedAt: Date.now() }),
    })).json() as { outcome: string };
    expect(["recorded", "raced"]).toContain(commit.outcome);
  });

  it("refuses a lease for a revision R2 no longer holds", async () => {
    const path = "notes/ns-cold-stale.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "content");
    const denied = await coldAcquire(path, "etag-that-does-not-exist");
    expect(denied.outcome).toBe("denied");
    // Hot ownership is checked first: a live session is the more important refusal to report.
    expect(["hot-owned", "remote-changed"]).toContain(denied.reason!);
    session.socket.close();
    void identity;
  });

  it("denies a cold delete of a path a hot session holds", async () => {
    const path = "notes/ns-cold-delete.md";
    const { session } = await hotPathWithContent(path, "client-a", "content");
    const response = await request(`/v1/channels/${channel}/hot/cold/acquire`, {
      method: "POST",
      body: JSON.stringify({ protocol: 1, operationId: "cold-delete-1", operation: "delete", canonicalPath: path, clientId: "cold-writer", expectedRemoteETag: null }),
    });
    const result = await response.json() as ColdAuthorityResult;
    expect(result.outcome).toBe("denied");
    expect(result.reason).toBe("hot-owned");
    session.socket.close();
  });
});

describe("hot conflict resolution", () => {
  async function resolve(body: Record<string, unknown>): Promise<{ status: number; result: { outcome: string } }> {
    const response = await request(`/v1/channels/${channel}/hot/resolve`, { method: "POST", body: JSON.stringify({ protocol: 1, ...body }) });
    return { status: response.status, result: await response.json() as { outcome: string } };
  }

  it("re-points the room at the current revision and owes a save when the user keeps local", async () => {
    const path = "notes/ns-resolve-keep.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "ours");
    // Someone else rewrites R2 behind the room's back: the room's precondition no longer matches.
    const before = await bindings().MINERAL.put(path, "theirs");
    const roomStub = bindings().ROOM.getByName(identity.documentId);
    const room = roomStub as unknown as { describe(): Promise<{ pendingSave: boolean; state: string } | null> };

    const resolved = await resolve({ operationId: "resolve-keep-1", canonicalPath: path, documentId: identity.documentId, epoch: identity.epoch, decision: "keep-local" });
    expect(resolved.status).toBe(200);
    expect(resolved.result.outcome).toBe("resolved");

    // The decision is that local wins, so the room is dirty again and its next checkpoint writes under
    // the *new* remote revision rather than the stale one it was holding.
    expect((await room.describe())?.pendingSave).toBe(true);
    expect((await bindings().MINERAL.head(path))?.etag).toBe(before!.etag);
    // The room owes the save, and its own alarm does the writing: no client has to stay connected for a
    // decision the user already made.
    await runDurableObjectAlarm(roomStub);
    expect(await objectText(path), "the decided version is what R2 ends up holding").toBe("ours");
    session.socket.close();
  });

  it("releases the fence when the user accepts the remote version", async () => {
    const path = "notes/ns-resolve-accept.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "ours");
    const before = await pathStatus(path);
    expect(before.hotOwned).toBe(true);

    const resolved = await resolve({ operationId: "resolve-accept-1", canonicalPath: path, documentId: identity.documentId, epoch: identity.epoch, decision: "accept-remote" });
    expect(resolved.status).toBe(200);
    expect(resolved.result.outcome).toBe("abandoned");

    // Ownership is gone once this device lets go of the document — which is what the decision means, and
    // what the plugin does immediately after: it stops the session instead of handing it off.
    session.socket.close();
    const released = await waitFor(async () => (await pathStatus(path)).hotOwned === false);
    expect(released, "the path must become cold-mutable again").toBe(true);
    const lease = await request(`/v1/channels/${channel}/hot/cold/acquire`, {
      method: "POST",
      body: JSON.stringify({ protocol: 1, operationId: "cold-after-accept", operation: "put", canonicalPath: path, clientId: "cold-writer", expectedRemoteETag: before.remote?.etag ?? null }),
    });
    expect((await lease.json() as ColdAuthorityResult).outcome).toBe("granted");
  });

  it("answers not-found for a path it knows nothing about", async () => {
    const resolved = await resolve({ operationId: "resolve-unknown", canonicalPath: "notes/ns-resolve-unknown.md", documentId: "AbCdEfGhIjKlMnOpQrStUv", epoch: 1, decision: "keep-local" });
    expect(resolved.status).toBe(404);
    expect(resolved.result.outcome).toBe("not-found");
  });
});

describe("namespace operations finish without their client", () => {
  /** The knowledge base's coordinator, with the test deployment's failure seam. */
  function coordinatorStub() {
    return bindings().COORDINATOR.getByName(channel) as unknown as DurableObjectStub & {
      failNextDeletes(count: number): Promise<void>;
      failNextMoves(count: number): Promise<void>;
      loseNextMoveResponses(count: number): Promise<void>;
    };
  }

  it("resumes a delete its client walked away from", async () => {
    const path = "notes/ns-resume-delete.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "about to be deleted");
    session.socket.close();

    // A throwing Vault call is what a client that disappeared mid-operation leaves behind: the operation
    // is recorded, the binding is quiescing, and nobody is coming back to ask again with that id.
    const coordinator = coordinatorStub();
    await coordinator.failNextDeletes(1);
    // The route surfaces the failure as an error response (or, in this pool, a rejected fetch); either
    // way the client learns nothing and the record is what remains.
    const interrupted = await namespace({ type: "delete", operationId: "resume-delete-1", clientId: "client-a", canonicalPath: path, documentId: identity.documentId, expectedEpoch: identity.epoch, expectedRemoteETag: null, expectedDocumentRevision: null });
    expect(interrupted.result).toMatchObject({ outcome: "rejected", reason: "unavailable", phase: "checkpointed" });
    expect((await pathStatus(path)).binding?.state, "the path is left mid-operation").toBe("quiescing");

    // The object's own alarm finishes what the client could not.
    const resumed = await waitFor(async () => {
      await runDurableObjectAlarm(coordinator);
      return (await pathStatus(path)).binding?.state === "deleted";
    }, 12);
    expect(resumed, "the resume alarm must complete the delete").toBe(true);
    const after = await pathStatus(path);
    expect(after.remote?.deleted).toBe(true);
    expect(after.hotOwned).toBe(false);
  });

  it("fails an operation explicitly instead of leaving its path quiescing forever", async () => {
    const path = "notes/ns-resume-exhausted.md";
    const { identity, session } = await hotPathWithContent(path, "client-b", "never deleted");
    session.socket.close();

    // The Vault stays broken, so every resume attempt fails until the attempts run out.
    const coordinator = coordinatorStub();
    await coordinator.failNextDeletes(100);
    const interrupted = await namespace({ type: "delete", operationId: "resume-delete-2", clientId: "client-b", canonicalPath: path, documentId: identity.documentId, expectedEpoch: identity.epoch, expectedRemoteETag: null, expectedDocumentRevision: null });
    expect(interrupted.result).toMatchObject({ outcome: "rejected", reason: "unavailable", phase: "checkpointed" });
    expect((await pathStatus(path)).binding?.state).toBe("quiescing");

    const released = await waitFor(async () => {
      await runDurableObjectAlarm(coordinator);
      return (await pathStatus(path)).binding?.state !== "quiescing";
    }, 14);
    expect(released, "a path may not stay quiescing when nobody can finish the operation").toBe(true);
    // Usable again, and repeating the operation is a *new* attempt that must produce a definite answer
    // rather than an eternal "pending". The exhausted record stays as the audit trail of what nobody
    // finished; a retry is deliberately allowed to succeed if the Vault has recovered by then.
    expect((await pathStatus(path)).binding?.state).toBe("active");
    const retry = await namespace({ type: "delete", operationId: "resume-delete-2", clientId: "client-b", canonicalPath: path, documentId: identity.documentId, expectedEpoch: identity.epoch, expectedRemoteETag: null, expectedDocumentRevision: null }).catch(() => undefined);
    expect(retry === undefined || ["rejected", "conflict"].includes(retry.result.outcome), "a retry must produce a definite failure, not pending").toBe(true);
  });

  it("returns a typed rename failure and resumes the same commit from the checkpointed phase", async () => {
    const fromPath = "notes/ns-resume-rename.md";
    const toPath = "notes/ns-resume-renamed.md";
    const { identity, session } = await hotPathWithContent(fromPath, "client-c", "rename survives rpc loss");
    session.socket.close();

    const coordinator = coordinatorStub();
    await coordinator.failNextMoves(1);
    const interrupted = await namespace({
      type: "rename",
      operationId: "resume-rename-1",
      clientId: "client-c",
      fromPath,
      toPath,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch,
      expectedFromBinding: { documentId: identity.documentId, epoch: identity.epoch },
      expectedToPathState: { state: "absent" },
    });
    expect(interrupted.result).toMatchObject({ outcome: "rejected", reason: "unavailable", phase: "checkpointed" });
    expect((await pathStatus(fromPath)).binding?.state).toBe("quiescing");

    const resumed = await waitFor(async () => {
      await runDurableObjectAlarm(coordinator);
      return (await pathStatus(toPath)).binding?.state === "active";
    }, 12);
    expect(resumed, "the resume alarm must complete the rename").toBe(true);
    expect((await pathStatus(fromPath)).binding?.state).toBe("deleted");
  });

  it("recovers a rename committed by the Vault when only its response was lost", async () => {
    const fromPath = "notes/ns-lost-rename-response.md";
    const toPath = "notes/ns-lost-rename-response-recovered.md";
    const { identity, session } = await hotPathWithContent(fromPath, "client-d", "committed before response loss");
    session.socket.close();

    const coordinator = coordinatorStub();
    await coordinator.loseNextMoveResponses(1);
    const interrupted = await namespace({
      type: "rename",
      operationId: "resume-rename-lost-response-1",
      clientId: "client-d",
      fromPath,
      toPath,
      documentId: identity.documentId,
      expectedEpoch: identity.epoch,
      expectedFromBinding: { documentId: identity.documentId, epoch: identity.epoch },
      expectedToPathState: { state: "absent" },
    });
    expect(interrupted.result).toMatchObject({ outcome: "rejected", reason: "unavailable", phase: "checkpointed" });

    const resumed = await waitFor(async () => {
      await runDurableObjectAlarm(coordinator);
      return (await pathStatus(toPath)).binding?.state === "active";
    }, 12);
    expect(resumed, "the same commit id must recover its receipt instead of reporting target-exists").toBe(true);
    expect((await pathStatus(fromPath)).binding?.state).toBe("deleted");
  });
});

describe("tombstone namespace", () => {
  it("stores tombstones outside every document path", async () => {
    const { session } = await hotPathWithContent("notes/ns-tombstone.md", "client-a", "x");
    const objects = await bindings().MINERAL.list({ prefix: TOMBSTONE_NAMESPACE });
    expect(objects.objects.length).toBeGreaterThan(0);
    session.socket.close();
  });
});

describe("path observation", () => {
  it("reports a binding and the effective remote state, but never content", async () => {
    const path = "notes/ns-observe.md";
    const { identity, session } = await hotPathWithContent(path, "client-a", "observed");
    const status = await pathStatus(path);
    expect(status.binding?.documentId).toBe(identity.documentId);
    expect(status.binding?.state).toBe("active");
    expect(status.remote?.exists).toBe(true);
    expect(status.remote?.etag).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain("observed");
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



