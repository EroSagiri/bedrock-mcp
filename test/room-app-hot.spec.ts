import { SELF, evictDurableObject } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeHotPayload, encodeHotPayload, type HotAcquireResult } from "@mineral/sync-core/hot-protocol";
import { parseTextUI, patchValues } from "@mineral/textui";
import { bindings, hotRoom, seedRoomAppSearch, vaultEntrypoint } from "./support";

const channel = "H".repeat(43);
let sequence = 0;
const opened: WebSocket[] = [];
async function post(action: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/${action}`, { method: "POST", headers: { Authorization: "Bearer gateway-test-token" }, body: JSON.stringify({ protocol: 1, ...body }) });
}

async function session(path: string, clientId: string) {
  const acquired = await (await post("acquire", { operationId: crypto.randomUUID(), canonicalPath: path, clientId, expected: { state: "unknown" }, local: null, wantSession: true })).json<HotAcquireResult>();
  expect(["created", "joined"]).toContain(acquired.outcome);
  const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/hot/session?ticket=${encodeURIComponent(acquired.sessionTicket!)}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  opened.push(socket);
  const doc = new Y.Doc();
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (frame.type === "welcome") Y.applyUpdate(doc, decodeHotPayload(String(frame.crdtState))!);
    if (frame.type === "operation") Y.applyUpdate(doc, decodeHotPayload(String(frame.update))!);
    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else received.push(frame);
  });
  const until = (predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise(resolve => {
    const index = received.findIndex(predicate);
    if (index >= 0) resolve(received.splice(index, 1)[0]);
    else waiters.push({ predicate, resolve });
  });
  socket.accept();
  const welcome = await until(frame => frame.type === "welcome");
  const text = () => doc.getText("markdown").toString();
  const edit = async (next: string) => {
    const vector = Y.encodeStateVector(doc);
    doc.transact(() => { const body = doc.getText("markdown"); body.delete(0, body.length); body.insert(0, next); });
    const id = `app-edit-${++sequence}`;
    socket.send(JSON.stringify({ protocol: 1, type: "operation", ...acquired.identity, clientId, clientOperationId: id, parentRevision: 0, update: encodeHotPayload(Y.encodeStateAsUpdate(doc, vector)) }));
    await until(frame => frame.type === "ack" && frame.clientOperationId === id);
  };
  return { acquired, socket, doc, welcome, until, text, edit };
}

afterAll(() => { for (const socket of opened) socket.close(); });

describe("registered apps on real hot rooms", () => {
  it("shares game turns, restores erased progress and resumes private game state after room eviction", async () => {
    const path = "arcade/games.ui.md";
    const first = await session(path, "arcade-first"), second = await session(path, "arcade-second");
    expect(first.text()).toContain("纸上游乐场"); expect(second.text()).toBe(first.text());
    const marker = (peer: typeof first) => JSON.parse(parseTextUI(peer.text()).blocks.get("games-public")?.value ?? "{}");
    const act = async (name: string, entry?: string) => {
      const turn = marker(first).turn;
      await first.edit(patchValues(parseTextUI(first.text()), new Map<string, string | boolean>([[`g-${turn}-${name}`, true], ...(entry === undefined ? [] : [["entry", entry] as [string, string]])])));
      await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && marker(peer).turn === turn + 1)));
    };
    await act("play-code"); await act("guess", "1234");
    expect(parseTextUI(first.text()).controls.get("code-progress")?.value).toContain("1/8");
    expect(first.text()).toBe(second.text()); expect(first.text()).not.toContain('"secret"');
    await first.edit("");
    await Promise.all([first, second].map(peer => peer.until(frame => frame.type === "operation" && peer.text().includes("自动恢复"))));
    expect(parseTextUI(first.text()).controls.get("code-progress")?.value).toContain("1/8");
    first.socket.close(); second.socket.close();
    await evictDurableObject(hotRoom(first.acquired.identity!.documentId));
    const restored = await session(path, "arcade-restored");
    expect(parseTextUI(restored.text()).controls.get("code-progress")?.value).toContain("1/8");
    expect(JSON.parse(parseTextUI(restored.text()).blocks.get("games-public")!.value).turn).toBe(2);
    restored.socket.close();
  }, 15_000);

  it("runs semantic retrieval and management through the production Vault RPC", async () => {
    await seedRoomAppSearch({ "app-vector/one.md": "# Quartz pipeline\nThe mineral pipeline broadcasts bundles every night." }, true);
    const peer = await session("app-vector/workbench.ui.md", "vector-workbench");
    await peer.edit(patchValues(parseTextUI(peer.text()), new Map<string, string | boolean>([["query", "mineral pipeline"], ["mode", "向量"], ["search", true]])));
    await peer.until(frame => frame.type === "operation" && JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")!.value).phase === "done");
    const state = JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")!.value);
    expect(state.results[0].key).toBe("app-vector/one.md");
    expect(state.status).toContain("向量检索已完成");
    await peer.edit(patchValues(parseTextUI(peer.text()), new Map([["manage", true]])));
    await peer.until(frame => frame.type === "operation" && JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")!.value).health !== null);
    expect(JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")!.value).health).toMatchObject({ documents: 1, vectors: 1, vectorAvailable: true });
    peer.socket.close();
  });

  it("repairs a cleared screen, adopts damaged clients and retains its app when renamed", async () => {
    await seedRoomAppSearch({ "app-repair/one.md": "# Recovery\nrecoverablecontent" });
    const path = "app-repair/workbench.ui.md";
    const peer = await session(path, "repair-first");
    await peer.edit(patchValues(parseTextUI(peer.text()), new Map<string, string | boolean>([["query", "recoverablecontent"], ["search", true]])));
    await peer.until(frame => frame.type === "operation" && peer.text().includes("obsidian://open?file=app-repair%2Fone"));
    await peer.edit("");
    await peer.until(frame => frame.type === "operation" && peer.text().includes("自动恢复"));
    expect(JSON.parse(parseTextUI(peer.text()).blocks.get("workbench-state")!.value).results[0].key).toBe("app-repair/one.md");
    const damaged = await (await post("acquire", { operationId: crypto.randomUUID(), canonicalPath: path, clientId: "repair-damaged", expected: { state: "unknown" }, local: { contentHash: "0".repeat(64), size: 20 }, wantSession: false })).json<HotAcquireResult>();
    expect(damaged.outcome).toBe("joined");
    const identity = peer.acquired.identity!;
    const toPath = "app-repair/my-desk.ui.md";
    const renamed = await (await post("namespace", { type: "rename", operationId: crypto.randomUUID(), clientId: "repair-first", fromPath: path, toPath,
      documentId: identity.documentId, expectedEpoch: identity.epoch, expectedFromBinding: identity, expectedToPathState: { state: "absent" } })).json<Record<string, unknown>>();
    expect(renamed.outcome).toBe("applied");
    const next = await session(toPath, "repair-renamed");
    await next.edit("");
    await next.until(frame => frame.type === "operation" && next.text().includes("知识库工作台"));
    expect(JSON.parse(parseTextUI(next.text()).blocks.get("workbench-state")!.value).results).toHaveLength(1);
    peer.socket.close(); next.socket.close();
    await evictDurableObject(hotRoom(next.acquired.identity!.documentId));
    const restored = await session(toPath, "repair-restarted");
    expect(restored.text()).toContain("知识库工作台");
    restored.socket.close();
  }, 15_000);

  it("creates a React search screen, searches the real index, converges and checkpoints", async () => {
    await seedRoomAppSearch({ "app-search/daily/one.md": "# 心率记录\n实时查看心率的工具", "app-search/other/two.md": "另一个心率工具" });
    const path = "app-search/workbench.ui.md";
    const first = await session(path, "search-device-a");
    expect(first.text()).toContain("知识库搜索");
    expect(first.welcome.serverRevision).toBe(1);
    const second = await session(path, "search-device-b");
    expect(second.text()).toBe(first.text());
    const next = patchValues(parseTextUI(first.text()), new Map<string, string | boolean>([["query", "心率"], ["prefix", "app-search/daily"], ["search", true]]));
    await first.edit(next);
    await first.until(frame => frame.type === "operation" && first.text().includes("实时查看心率"));
    await second.until(frame => frame.type === "operation" && second.text().includes("实时查看心率"));
    expect(second.text()).toBe(first.text());
    expect(first.text()).not.toContain("另一个心率工具");
    expect(first.text()).toContain("obsidian://open?file=app-search%2Fdaily%2Fone");
    first.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", ...first.acquired.identity, clientId: "search-device-a", clientOperationId: "save-search", upToRevision: 0 }));
    await first.until(frame => frame.type === "checkpoint");
    expect(await (await bindings().MINERAL.get(path))!.text()).toBe(first.text());
    first.socket.close(); second.socket.close();
    await evictDurableObject(hotRoom(first.acquired.identity!.documentId));
    const reopened = await session(path, "search-device-c");
    expect(JSON.parse(parseTextUI(reopened.text()).blocks.get("workbench-state")!.value).route).toBe("/results");
    expect(reopened.text()).toContain("实时查看心率");
    reopened.socket.close();
  });

  it("does not start an app for ordinary or unregistered filenames", async () => {
    for (const path of ["app-plain/ordinary.md", "app-plain/unknown.ui.md"]) {
      const peer = await session(path, `plain-${sequence++}`);
      expect(peer.text()).toBe("");
      await peer.edit("ordinary document");
      expect(peer.text()).toBe("ordinary document");
      peer.socket.close();
    }
  });

  it("stops on rename to an ordinary note while the same hot document remains editable", async () => {
    const fromPath = "app-rename/workbench.ui.md", toPath = "app-rename/plain.md";
    const peer = await session(fromPath, "rename-app-client");
    const identity = peer.acquired.identity!;
    const result = await (await post("namespace", { type: "rename", operationId: crypto.randomUUID(), clientId: "rename-app-client", fromPath, toPath,
      documentId: identity.documentId, expectedEpoch: identity.epoch, expectedFromBinding: identity, expectedToPathState: { state: "absent" } })).json<Record<string, unknown>>();
    expect(result.outcome).toBe("applied");
    await peer.until(frame => frame.type === "document-state" && frame.reason === "renamed");
    const next = await session(toPath, "renamed-app-client");
    await next.edit("ordinary note after rename");
    next.socket.send(JSON.stringify({ protocol: 1, type: "checkpoint-request", ...next.acquired.identity, clientId: "renamed-app-client", clientOperationId: "renamed-save", upToRevision: 0 }));
    await next.until(frame => frame.type === "checkpoint");
    expect(await (await bindings().MINERAL.get(toPath))!.text()).toBe("ordinary note after rename");
    peer.socket.close(); next.socket.close();
  });

  it("keeps UI projections out of both indexing paths", async () => {
    await seedRoomAppSearch({ "app-exclude/workbench.ui.md": "projectionuniqueword", "app-exclude/normal.md": "normaluniqueword" });
    const result = await vaultEntrypoint().queryIndex("search", { query: "projectionuniqueword" });
    expect(result.results).toEqual([]);
    expect((await vaultEntrypoint().queryIndex("search", { query: "normaluniqueword" })).results).toHaveLength(1);
  });
});
