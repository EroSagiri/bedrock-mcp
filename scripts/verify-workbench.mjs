import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { parseTextUI, patchValues } from "@mineral/textui";
import { deriveRemoteChangeChannel } from "../packages/sync-core/dist/channel.js";
import { decodeHotPayload, encodeHotPayload } from "../packages/sync-core/dist/hot-protocol.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const channel = await deriveRemoteChangeChannel(config);
const root = `.mineral/hot-verify/workbench-${Date.now().toString(36)}`;
const path = `${root}/workbench.ui.md`;
const peers = [];
let identity;
const check = (condition, label) => { if (!condition) throw new Error(label); console.log(`PASS ${label}`); };
async function post(action, body) {
  const response = await fetch(`${config.gatewayEndpoint}/v1/channels/${channel}/hot/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${config.gatewayToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocol: 1, ...body }),
  });
  if (!response.ok) throw new Error(`Gateway refused ${action}: HTTP ${response.status}`);
  return response.json();
}
async function join(clientId) {
  const acquired = await post("acquire", { operationId: crypto.randomUUID(), canonicalPath: path, clientId, expected: { state: "unknown" }, local: null, wantSession: true });
  check(["created", "joined"].includes(acquired.outcome), "join registered screen");
  identity = acquired.identity;
  const socket = new WebSocket(`${config.gatewayEndpoint.replace(/^http/, "ws")}/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(acquired.sessionTicket)}`);
  const doc = new Y.Doc(), queue = [], waiters = [];
  const text = () => doc.getText("markdown").toString();
  let revision = 0;
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "welcome") Y.applyUpdate(doc, decodeHotPayload(frame.crdtState));
    if (frame.type === "operation") Y.applyUpdate(doc, decodeHotPayload(frame.update));
    revision = Math.max(revision, frame.serverRevision ?? 0);
    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame); else queue.push(frame);
  });
  const until = predicate => new Promise((resolve, reject) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) { resolve(queue.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(new Error("Search app frame timeout")), 20000);
    waiters.push({ predicate, resolve: frame => { clearTimeout(timer); resolve(frame); } });
  });
  const peer = { clientId, socket, doc, text, until, revision: () => revision, acquired };
  peers.push(peer);
  await until(frame => frame.type === "welcome");
  return peer;
}

try {
  const first = await join(`search-a-${crypto.randomUUID()}`);
  check(first.text().includes("知识库搜索"), "React search route initialized on join");
  const second = await join(`search-b-${crypto.randomUUID()}`);
  check(first.text() === second.text(), "second client receives same screen");
  const next = patchValues(parseTextUI(first.text()), new Map([["query", "同步"], ["prefix", ""], ["search", true]]));
  const vector = Y.encodeStateVector(first.doc), body = first.doc.getText("markdown");
  first.doc.transact(() => { body.delete(0, body.length); body.insert(0, next); });
  first.socket.send(JSON.stringify({ protocol: 1, type: "operation", ...identity, clientId: first.clientId, clientOperationId: crypto.randomUUID(), parentRevision: first.revision(), update: encodeHotPayload(Y.encodeStateAsUpdate(first.doc, vector)) }));
  const finished = peer => peer.until(frame => frame.type === "operation" && JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state").value).phase === "done");
  await Promise.all([finished(first), finished(second)]);
  const state = JSON.parse(parseTextUI(first.text()).blocks.get("workbench-state").value);
  check(state.route === "/results", "React results route selected");
  check(state.status.startsWith("索引可用"), "deployed Vault index answers search");
  check(state.results.length > 0 && first.text().includes("obsidian://open?file="), "real indexed snippets and note links rendered");
  check(first.text() === second.text(), "both hot clients converge");
  const stateOf = peer => JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")?.value ?? "{}");
  const edit = async values => {
    const next = typeof values === "string" ? values : patchValues(parseTextUI(first.text()), new Map(Object.entries(values)));
    const vector = Y.encodeStateVector(first.doc), body = first.doc.getText("markdown");
    first.doc.transact(() => { body.delete(0, body.length); body.insert(0, next); });
    first.socket.send(JSON.stringify({ protocol: 1, type: "operation", ...identity, clientId: first.clientId, clientOperationId: crypto.randomUUID(), parentRevision: first.revision(), update: encodeHotPayload(Y.encodeStateAsUpdate(first.doc, vector)) }));
  };
  if (state.results.length > 5) {
    await edit({ next: true });
    await first.until(frame => frame.type === "operation" && stateOf(first).page === 1);
    check(parseTextUI(first.text()).blocks.has("hit-5"), "deployed pagination renders the next ranked page");
    await edit({ prev: true });
    await first.until(frame => frame.type === "operation" && stateOf(first).page === 0);
  }
  await edit({ "bookmark-0": true });
  await first.until(frame => frame.type === "operation" && stateOf(first).saved?.length === 1);
  await edit("");
  await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && stateOf(peer).saved?.length === 1 && peer.text().includes("自动恢复"))));
  check(stateOf(first).results.length === state.results.length && first.text() === second.text(), "empty client text recovers query, bookmarks and both screens");
  await edit({ manage: true });
  await first.until(frame => frame.type === "operation" && stateOf(first).route === "/manage" && stateOf(first).phase === "done");
  check(stateOf(first).health.ready, "deployed workbench management reads index health");
  console.log("Vector service available: " + stateOf(first).health.vectorAvailable);
  await edit({ mode: "向量", query: "知识库笔记同步管理", search: true });
  await first.until(frame => frame.type === "operation" && stateOf(first).route === "/results" && stateOf(first).phase === "done");
  check(stateOf(first).status.startsWith("向量检索已完成"), "real Workers AI and Vectorize answer semantic retrieval");
  console.log("Semantic results: " + stateOf(first).results.length);
  await second.until(frame => frame.type === "operation" && stateOf(second).mode === "向量" && stateOf(second).phase === "done");
  first.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", ...identity, clientId: first.clientId, clientOperationId: crypto.randomUUID(), upToRevision: first.revision() }));
  await first.until(frame => frame.type === "checkpoint" && frame.documentRevision >= first.revision());
  check(true, "application output checkpointed through Vault");
  for (const peer of peers) {
    await post("release", { operationId: crypto.randomUUID(), clientId: peer.clientId, ...identity, lastAcceptedRevision: peer.revision(), checkpoint: true });
    peer.socket.close();
  }
  const reopened = await join(`search-c-${crypto.randomUUID()}`);
  check(reopened.text() === first.text(), "saved search and route restored after all clients leave");
  console.log(`Workbench verification passed (${state.results.length} indexed results).`);
} finally {
  for (const peer of peers) { try { peer.socket.close(); } catch {} }
  if (identity) {
    const removed = await post("namespace", { type: "delete", operationId: crypto.randomUUID(), clientId: `search-cleanup-${crypto.randomUUID()}`, canonicalPath: path, documentId: identity.documentId, expectedEpoch: identity.epoch, expectedRemoteETag: null, expectedDocumentRevision: null });
    check(["applied", "duplicate"].includes(removed.outcome), "verification document cleaned up");
  }
}

// The verification document is retired before exit; native WebSocket close handshakes can linger.
process.exit(0);
