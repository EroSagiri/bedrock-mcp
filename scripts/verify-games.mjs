import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { parseTextUI, patchValues } from "@mineral/textui";
import { deriveRemoteChangeChannel } from "../packages/sync-core/dist/channel.js";
import { decodeHotPayload, encodeHotPayload } from "../packages/sync-core/dist/hot-protocol.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const channel = await deriveRemoteChangeChannel(config);
const path = `.mineral/hot-verify/arcade-${Date.now().toString(36)}/games.ui.md`;
const peers = [];
let identity;
const check = (value, label) => { if (!value) throw new Error(label); console.log(`PASS ${label}`); };
async function post(action, body) {
  const response = await fetch(`${config.gatewayEndpoint}/v1/channels/${channel}/hot/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${config.gatewayToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ protocol: 1, ...body }),
  });
  if (!response.ok) throw new Error(`Gateway refused ${action}: HTTP ${response.status}`);
  return response.json();
}
async function join(clientId) {
  const acquired = await post("acquire", { operationId: crypto.randomUUID(), canonicalPath: path, clientId, expected: { state: "unknown" }, local: null, wantSession: true });
  check(["created", "joined"].includes(acquired.outcome), "join registered arcade");
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
    const timer = setTimeout(() => reject(new Error("Arcade frame timeout")), 20000);
    waiters.push({ predicate, resolve: frame => { clearTimeout(timer); resolve(frame); } });
  });
  const peer = { clientId, socket, doc, text, until, revision: () => revision };
  peers.push(peer); await until(frame => frame.type === "welcome"); return peer;
}
const marker = peer => JSON.parse(parseTextUI(peer.text()).blocks.get("games-public")?.value ?? "{}");
const output = (peer, id) => String(parseTextUI(peer.text()).controls.get(id)?.value ?? "");
try {
  const first = await join(`arcade-a-${crypto.randomUUID()}`), second = await join(`arcade-b-${crypto.randomUUID()}`);
  check(first.text().includes("纸上游乐场") && marker(first).route === "/", "TSX game lobby initializes");
  check(first.text() === second.text(), "two clients share one game table");
  const edit = async next => {
    const vector = Y.encodeStateVector(first.doc), body = first.doc.getText("markdown");
    first.doc.transact(() => { body.delete(0, body.length); body.insert(0, next); });
    const operationId = crypto.randomUUID();
    first.socket.send(JSON.stringify({ protocol: 1, type: "operation", ...identity, clientId: first.clientId, clientOperationId: operationId, parentRevision: first.revision(), update: encodeHotPayload(Y.encodeStateAsUpdate(first.doc, vector)) }));
    await first.until(frame => frame.type === "ack" && frame.clientOperationId === operationId);
  };
  const act = async (name, entry) => {
    const turn = marker(first).turn;
    await edit(patchValues(parseTextUI(first.text()), new Map([[`g-${turn}-${name}`, true], ...(entry === undefined ? [] : [["entry", entry]])])));
    await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && marker(peer).turn === turn + 1)));
    check(first.text() === second.text(), `clients converge after ${name}`);
  };
  await act("play-mines"); await act("reveal", "B3");
  const progress = output(first, "mines-progress");
  check(progress.includes("1 次翻开") && !progress.includes("踩雷") && !progress.startsWith("0/"), "first mine move safely opens neighboring cells");
  check(!first.text().includes('"bombs"') && !first.text().includes('"seed"'), "mine secrets are absent from Markdown");
  await edit("");
  await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && peer.text().includes("自动恢复"))));
  check(output(first, "mines-progress") === progress && first.text() === second.text(), "erased game board repairs with progress intact");
  await act("home"); await act("play-code"); await act("guess", "1111");
  check(output(first, "code-progress").includes("0/8"), "invalid code spends no attempt");
  await act("guess", "1234"); check(output(first, "code-progress").includes("1/8"), "code guess produces shared deduction history");
  const attempts = output(first, "code-progress"), staleId = `g-${marker(first).turn - 1}-guess`, turn = marker(first).turn;
  await edit(first.text() + `\n- [x] old action <!-- textui:id=${staleId} type=action -->\n`);
  await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && marker(peer).turn === turn + 1)));
  check(output(first, "code-progress") === attempts, "stale action cannot spend another attempt");
  await act("home"); await act("play-quest"); await act("choose-supplies");
  check(output(first, "quest-progress").includes("第 2/8 页") && first.text().includes("共享战报"), "branching adventure advances and records its story");
  await act("retreat"); await act("home"); await act("records");
  check(first.text().includes("这张游戏桌的战绩") && first.text().includes("累计积分"), "shared records settle adventure rewards");
  first.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", ...identity, clientId: first.clientId, clientOperationId: crypto.randomUUID(), upToRevision: first.revision() }));
  await first.until(frame => frame.type === "checkpoint" && frame.documentRevision >= first.revision());
  check(true, "arcade output checkpointed through Vault");
  for (const peer of peers) { await post("release", { operationId: crypto.randomUUID(), clientId: peer.clientId, ...identity, lastAcceptedRevision: peer.revision(), checkpoint: true }); peer.socket.close(); }
  const reopened = await join(`arcade-c-${crypto.randomUUID()}`);
  check(reopened.text() === first.text(), "all clients leave and rejoin with records preserved");
} finally {
  for (const peer of peers) { try { peer.socket.close(); } catch {} }
  if (identity) {
    const removed = await post("namespace", { type: "delete", operationId: crypto.randomUUID(), clientId: `arcade-cleanup-${crypto.randomUUID()}`, canonicalPath: path, documentId: identity.documentId, expectedEpoch: identity.epoch, expectedRemoteETag: null, expectedDocumentRevision: null });
    check(["applied", "duplicate"].includes(removed.outcome), "verification game file deleted");
  }
}
// The verification file is retired before exit; native WebSocket close handshakes can linger.
process.exit(0);
