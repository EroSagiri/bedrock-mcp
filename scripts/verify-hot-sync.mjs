// End-to-end verification of the deployed hot-sync surface (Phase Hot-A/B/C).
//
// It drives the real Gateway and the real Vault in production, with two synthetic clients holding real
// Yjs documents, and asserts the invariants that cannot be checked locally: that a checkpoint really
// lands in R2 under the revision the receipt names, that the server still saves after a client stops
// asking, and that create/delete/rename move the namespace without moving the document.
//
// Everything it touches lives under `.mineral-sync/hot-verify/<run>/`, which is the sync layer's own
// namespace: the plugin ignores it and the index excludes it, so a verification run cannot appear in
// anyone's vault or search results. No secrets are printed.
//
// Usage: node scripts/verify-hot-sync.mjs <gatewayBaseUrl> <tokenFile> <identityFile>
//   identityFile: { "endpoint": "...", "bucket": "...", "remotePrefix": "" }

import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { deriveRemoteChangeChannel } from "../packages/sync-core/dist/channel.js";

const base = process.argv[2];
const tokenFile = process.argv[3];
const identityFile = process.argv[4];
if (!base || !tokenFile || !identityFile) {
  console.error("usage: node scripts/verify-hot-sync.mjs <gatewayBaseUrl> <tokenFile> <identityFile>");
  process.exit(2);
}

const token = readFileSync(tokenFile, "utf8").trim();
const identity = JSON.parse(readFileSync(identityFile, "utf8"));
const channel = await deriveRemoteChangeChannel({ endpoint: identity.endpoint, bucket: identity.bucket, remotePrefix: identity.remotePrefix ?? "" });
const auth = { Authorization: `Bearer ${token}` };
const runId = `r${Date.now().toString(36)}`;
const root = `.mineral-sync/hot-verify/${runId}`;
const results = [];

const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

let operationCounter = 0;
/**
 * Operation ids are unique per run, exactly as a client's must be per operation.
 *
 * A recycled id is not a harmless collision: the coordinator keys its idempotency on it, so the same id
 * naming a different intent is refused as `stale-intent` — which is the correct, and deliberately loud,
 * answer rather than a silent replay of somebody else's result.
 */
const nextOperationId = (prefix) => `${prefix}-${runId}-${++operationCounter}`;

async function post(action, body) {
  const response = await fetch(`${base}/v1/channels/${channel}/hot/${action}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function pathStatus(path) {
  const response = await fetch(`${base}/v1/channels/${channel}/hot/path?path=${encodeURIComponent(path)}`, { headers: auth });
  return await response.json();
}

/** A client with a socket, a queue of frames, and a Yjs document that mirrors what the room sent. */
async function connect(ticket) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(ticket)}`);
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data));
    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(frame);
      return;
    }
    queue.push(frame);
  });
  const until = (predicate, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return resolve(queue.splice(index, 1)[0]);
    const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
    waiters.push({ predicate, resolve: frame => { clearTimeout(timer); resolve(frame); } });
  });
  const welcome = await until(frame => frame.type === "welcome");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decode(welcome.crdtState));
  return {
    socket,
    until,
    doc,
    text: () => doc.getText("markdown").toString(),
    /** A full-state update: always self-contained, so the room can never hold it as a pending struct. */
    edit(mutate) {
      mutate(doc.getText("markdown"));
      return encode(Y.encodeStateAsUpdate(doc));
    },
    send(documentId, epoch, clientId, clientOperationId, update) {
      socket.send(JSON.stringify({ protocol: 1, type: "operation", documentId, epoch, clientId, clientOperationId, update, parentRevision: 0 }));
    },
    checkpoint(documentId, epoch, clientId) {
      socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", documentId, epoch, clientId, clientOperationId: nextOperationId("cp"), upToRevision: 0 }));
    },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

async function acquire(path, clientId, localText) {
  const { status, body } = await post("acquire", {
    protocol: 1,
    operationId: nextOperationId("acq"),
    canonicalPath: path,
    clientId,
    expected: { state: "unknown" },
    local: localText === undefined ? null : { contentHash: await hash(localText), size: localText.length },
    wantSession: true,
  });
  if (status !== 200 && status !== 409) throw new Error(`acquire failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main() {
  // 1. The control plane is reachable and the channel is the one this identity derives.
  const generation = await (await fetch(`${base}/v1/channels/${channel}`, { headers: auth })).json();
  record("gateway reachable and authenticated", /^\d+$/.test(String(generation.generation)), `generation=${generation.generation}`);

  // 2. Two clients open the same free path; the second joins the first incarnation.
  const pathA = `${root}/a.md`;
  const first = await acquire(pathA, "verify-a");
  record("first acquire creates an incarnation", first.outcome === "created" && first.identity?.epoch === 1, JSON.stringify(first.outcome));
  const second = await acquire(pathA, "verify-b");
  record("second acquire joins the same document", second.outcome === "joined" && second.identity?.documentId === first.identity.documentId, `${second.outcome}`);

  const identityA = first.identity;
  const a = await connect(first.sessionTicket);
  const b = await connect(second.sessionTicket);

  // 3. A's edit reaches B and is acknowledged with a revision.
  const firstOperationId = nextOperationId("op");
  const firstUpdate = a.edit(body => body.insert(0, "line one\n"));
  a.send(identityA.documentId, identityA.epoch, "verify-a", firstOperationId, firstUpdate);
  const ackA = await a.until(frame => frame.type === "ack");
  const relayed = await b.until(frame => frame.type === "operation");
  Y.applyUpdate(b.doc, decode(relayed.update));
  record("an operation is acknowledged", ackA.serverRevision === 1, `revision=${ackA.serverRevision}`);
  record("a peer receives the operation and converges", b.text() === "line one\n", JSON.stringify(b.text()));

  // 4. B edits, A converges: convergence is symmetric.
  b.send(identityA.documentId, identityA.epoch, "verify-b", nextOperationId("op"), b.edit(body => body.insert(body.length, "line two\n")));
  const ackB = await b.until(frame => frame.type === "ack");
  const relayedB = await a.until(frame => frame.type === "operation");
  Y.applyUpdate(a.doc, decode(relayedB.update));
  record("edits converge in both directions", ackB.serverRevision === 2 && a.text() === b.text(), JSON.stringify(a.text()));
  const latestRevision = ackB.serverRevision;

  // 5. The same frame sent twice is acknowledged once, with its original revision.
  a.send(identityA.documentId, identityA.epoch, "verify-a", firstOperationId, firstUpdate);
  const duplicate = await a.until(frame => frame.type === "ack" && frame.clientOperationId === firstOperationId);
  record("a retransmitted operation is deduplicated", duplicate.duplicate === true && duplicate.serverRevision === 1, `duplicate=${duplicate.duplicate} revision=${duplicate.serverRevision}`);

  // 6. A message from a different incarnation cannot be applied.
  a.send(identityA.documentId, identityA.epoch + 1, "verify-a", nextOperationId("op"), a.edit(() => {}));
  const stale = await a.until(frame => frame.type === "reject" || frame.type === "error");
  record("a stale-epoch operation is refused", stale.reason === "stale-epoch" || stale.code === "malformed", JSON.stringify(stale.reason ?? stale.code));

  // 7. A checkpoint names the exact revision, and R2 holds exactly that revision.
  const expectedText = a.text();
  a.checkpoint(identityA.documentId, identityA.epoch, "verify-a");
  const receipt = await a.until(frame => frame.type === "checkpoint" || frame.type === "document-state");
  record("a checkpoint receipt names the revision it covers", receipt.type === "checkpoint" && receipt.documentRevision === latestRevision, JSON.stringify(receipt.documentRevision ?? receipt.reason));
  record("the receipt's content hash is the materialized revision", receipt.contentHash === await hash(expectedText), String(receipt.contentHash).slice(0, 12));
  const observed = await pathStatus(pathA);
  record("R2 holds the revision the receipt names", observed.remote?.etag === receipt.r2ETag && observed.remote?.exists === true, `etag=${String(receipt.r2ETag).slice(0, 8)}`);

  // 8. The server saves without the client asking: one more edit, then nothing but time.
  const beforeAlarm = (await pathStatus(pathA)).remote.etag;
  a.send(identityA.documentId, identityA.epoch, "verify-a", nextOperationId("op"), a.edit(body => body.insert(body.length, "line three\n")));
  await a.until(frame => frame.type === "ack");
  let savedByAlarm = false;
  for (let attempt = 0; attempt < 24 && !savedByAlarm; attempt++) {
    await sleep(500);
    savedByAlarm = (await pathStatus(pathA)).remote.etag !== beforeAlarm;
  }
  record("the debounced checkpoint lands without a client request", savedByAlarm, `${String(beforeAlarm).slice(0, 8)} → changed`);

  // 9. A rename keeps the document and bumps the epoch; the old path stops being a document.
  const pathB = `${root}/b.md`;
  const renamed = await post("namespace", {
    protocol: 1,
    type: "rename",
    operationId: nextOperationId("rename"),
    clientId: "verify-a",
    fromPath: pathA,
    toPath: pathB,
    documentId: identityA.documentId,
    expectedEpoch: identityA.epoch,
    expectedFromBinding: { documentId: identityA.documentId, epoch: identityA.epoch },
    expectedToPathState: { state: "absent" },
  });
  record("rename is applied", renamed.body.outcome === "applied", JSON.stringify(renamed.body.reason ?? renamed.body.outcome));
  record("rename keeps the document and bumps the epoch", renamed.body.identity?.documentId === identityA.documentId && renamed.body.identity?.epoch === 2, JSON.stringify(renamed.body.identity));
  const fromStatus = await pathStatus(pathA);
  const toStatus = await pathStatus(pathB);
  record("the old path is effectively deleted", fromStatus.remote?.deleted === true && fromStatus.remote?.exists === false, JSON.stringify(fromStatus.remote?.deleted));
  record("the new path holds the document", toStatus.binding?.documentId === identityA.documentId && toStatus.binding?.epoch === 2 && toStatus.remote?.exists === true, JSON.stringify(toStatus.binding?.epoch));

  a.send(identityA.documentId, 1, "verify-a", nextOperationId("op"), a.edit(() => {}));
  const staleAfterRename = await a.until(frame => frame.type === "reject" || frame.type === "error");
  record("an operation from before the rename is refused", staleAfterRename.reason === "stale-epoch", JSON.stringify(staleAfterRename.reason ?? staleAfterRename.code));

  // 10. A deletion retires the revision and cannot be undone by a late edit.
  const deleted = await post("namespace", {
    protocol: 1,
    type: "delete",
    operationId: nextOperationId("delete"),
    clientId: "verify-a",
    canonicalPath: pathB,
    documentId: identityA.documentId,
    expectedEpoch: 2,
    expectedRemoteETag: toStatus.remote?.etag ?? null,
    expectedDocumentRevision: null,
  });
  record("delete is applied", deleted.body.outcome === "applied", JSON.stringify(deleted.body.reason ?? deleted.body.outcome));
  const afterDelete = await pathStatus(pathB);
  record("the deleted path reports effective deletion", afterDelete.remote?.deleted === true && afterDelete.binding?.state === "deleted", JSON.stringify(afterDelete.binding?.state));
  a.send(identityA.documentId, 2, "verify-a", nextOperationId("op"), a.edit(body => body.insert(0, "resurrect\n")));
  const lateEdit = await a.until(frame => frame.type === "reject" || frame.type === "document-state" || frame.type === "error");
  record("a late edit cannot resurrect the document", lateEdit.type !== "ack", JSON.stringify(lateEdit.reason ?? lateEdit.state ?? lateEdit.type));

  // 11. Recreating the path is a new incarnation, and the old tombstone does not hide it.
  const recreated = await acquire(pathB, "verify-c");
  record("recreate mints a new document", recreated.outcome === "created" && recreated.identity?.documentId !== identityA.documentId, JSON.stringify(recreated.outcome));
  const c = await connect(recreated.sessionTicket);
  c.send(recreated.identity.documentId, 1, "verify-c", nextOperationId("op"), c.edit(body => body.insert(0, "second life\n")));
  await c.until(frame => frame.type === "ack");
  c.checkpoint(recreated.identity.documentId, 1, "verify-c");
  const recreatedReceipt = await c.until(frame => frame.type === "checkpoint" || frame.type === "document-state");
  const recreatedStatus = await pathStatus(pathB);
  record("the recreated file is visible, not hidden by the old tombstone", recreatedStatus.remote?.exists === true && recreatedStatus.remote?.deleted === false, JSON.stringify(recreatedStatus.remote?.deleted));
  record("the recreated revision has its own content", recreatedReceipt.contentHash === await hash("second life\n"), String(recreatedReceipt.contentHash).slice(0, 12));

  // 12. A cold writer is fenced while the session is live.
  const coldWhileHot = await post("cold/acquire", { protocol: 1, operationId: nextOperationId("cold"), operation: "put", canonicalPath: pathB, clientId: "verify-cold", expectedRemoteETag: null });
  record("a cold write is refused while a hot session owns the path", coldWhileHot.body.outcome === "denied" && coldWhileHot.body.reason === "hot-owned", JSON.stringify(coldWhileHot.body.reason));

  // 13. A human decision about a conflict, on the deployed server.
  //
  // The decision itself is transport and ownership, which is what can break in a deployment: the route
  // must be authorized, the coordinator must keep (or drop) ownership accordingly, and the room must
  // still be able to save the version the user chose. Conflict *detection* is covered by the specs.
  const keepLocal = await post("resolve", { protocol: 1, operationId: nextOperationId("resolve"), canonicalPath: pathB, documentId: recreated.identity.documentId, epoch: 1, decision: "keep-local" });
  record("a keep-local decision is accepted", keepLocal.body.outcome === "resolved", JSON.stringify(keepLocal.body.outcome ?? keepLocal.body.reason));
  record("keep-local keeps the path owned by the session", (await pathStatus(pathB)).hotOwned === true, JSON.stringify((await pathStatus(pathB)).hotOwned));
  // What the decision is *for*: the document keeps working. The proof is the object in R2, not a frame:
  // the room may save from its own alarm before a checkpoint request even arrives, so waiting for a
  // receipt would be waiting for the wrong thing.
  const beforeDecisionEtag = (await pathStatus(pathB)).remote?.etag ?? null;
  c.send(recreated.identity.documentId, 1, "verify-c", nextOperationId("op"), c.edit(body => body.insert(body.length, "after decision\n")));
  await c.until(frame => frame.type === "ack");
  let savedAfterDecision = false;
  for (let attempt = 0; attempt < 20 && !savedAfterDecision; attempt++) {
    await sleep(500);
    savedAfterDecision = ((await pathStatus(pathB)).remote?.etag ?? null) !== beforeDecisionEtag;
  }
  record("the decided document keeps syncing to R2", savedAfterDecision, String(beforeDecisionEtag).slice(0, 8));

  const rejectUnknown = await post("resolve", { protocol: 1, operationId: nextOperationId("resolve"), canonicalPath: `${root}/missing.md`, documentId: recreated.identity.documentId, epoch: 1, decision: "keep-local" });
  record("an unknown path is refused rather than guessed", rejectUnknown.status === 404, String(rejectUnknown.status));

  const acceptRemote = await post("resolve", { protocol: 1, operationId: nextOperationId("resolve"), canonicalPath: pathB, documentId: recreated.identity.documentId, epoch: 1, decision: "accept-remote" });
  record("an accept-remote decision gives up ownership", acceptRemote.body.outcome === "abandoned", JSON.stringify(acceptRemote.body.outcome ?? acceptRemote.body.reason));

  // 14. Leaving hands the path back.
  const released = await post("release", { protocol: 1, operationId: nextOperationId("rel"), clientId: "verify-c", documentId: recreated.identity.documentId, epoch: 1, checkpoint: true, lastAcceptedRevision: 1 });
  c.close();
  a.close();
  b.close();
  let handedBack = false;
  for (let attempt = 0; attempt < 24 && !handedBack; attempt++) {
    await sleep(500);
    handedBack = (await pathStatus(pathB)).hotOwned === false;
  }
  record("closing the last session releases hot ownership", handedBack, JSON.stringify(released.body.outcome));
  const coldAfterIdle = await post("cold/acquire", { protocol: 1, operationId: nextOperationId("cold"), operation: "delete", canonicalPath: pathB, clientId: "verify-cold", expectedRemoteETag: null });
  record("a cold write is granted once the path is idle", coldAfterIdle.body.outcome === "granted", JSON.stringify(coldAfterIdle.body.reason ?? coldAfterIdle.body.outcome));

  // 15. Leave the namespace as it was found: the verification path ends deleted, not abandoned.
  const cleanup = await post("namespace", {
    protocol: 1,
    type: "delete",
    operationId: nextOperationId("cleanup"),
    clientId: "verify-c",
    canonicalPath: pathB,
    documentId: recreated.identity.documentId,
    expectedEpoch: 1,
    expectedRemoteETag: null,
    expectedDocumentRevision: null,
  });
  record("the verification path is cleaned up", cleanup.body.outcome === "applied", JSON.stringify(cleanup.body.reason ?? cleanup.body.outcome));

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed  (channel ${channel.slice(0, 6)}…, run ${runId})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();

