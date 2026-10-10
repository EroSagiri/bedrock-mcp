import { describe, expect, it } from "vitest";
import { MemoryScreen, parseTextUI, patchValues } from "@mineral/textui";
import { RoomAppRegistry, roomApps } from "../apps/room-apps/src/registry";
import { workbenchApp } from "../apps/room-apps/src/workbench/app";
import { HotScreenPort } from "../apps/room-apps/src/screen-port";

async function harness(query: (kind: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const host = new MemoryScreen();
  await host.setScreen("main", "replace this original document", { expectedRevision: null });
  const controller = new AbortController();
  let cached: unknown;
  const state = { read: async () => structuredClone(cached), write: async (value: unknown) => { cached = structuredClone(value); } };
  const context = { state, screen: host, screenId: "main", signal: controller.signal, index: { query } };
  await workbenchApp.run(context);
  const edit = async (values: Record<string, string | boolean>) => {
    const before = (await host.getScreen("main"))!;
    await host.setScreen("main", patchValues(parseTextUI(before.text), new Map(Object.entries(values))), { expectedRevision: before.revision });
  };
  return { host, controller, context, edit, text: async () => (await host.getScreen("main"))!.text };
}

describe("registered React room apps", () => {
  it("restores a cleared or partially damaged projection without losing queries and bookmarks", async () => {
    const app = await harness(async () => ({ indexReady: true, results: [{ key: "one.md", title: "One", snippet: "published result" }] }));
    await app.edit({ query: "hello", search: true }); await workbenchApp.run(app.context);
    await app.edit({ "bookmark-0": true }); await workbenchApp.run(app.context);
    const before = (await app.host.getScreen("main"))!;
    await app.host.setScreen("main", "", { expectedRevision: before.revision });
    await workbenchApp.run(app.context);
    let state = JSON.parse(parseTextUI(await app.text()).blocks.get("workbench-state")!.value);
    expect(state.results[0].key).toBe("one.md"); expect(state.saved[0].key).toBe("one.md");
    expect(state.history[0].query).toBe("hello"); expect(await app.text()).toContain("自动恢复");
    const damaged = (await app.host.getScreen("main"))!;
    await app.host.setScreen("main", damaged.text.replace(/关键词:[^\n]+/, "damaged control"), { expectedRevision: damaged.revision });
    await workbenchApp.run(app.context);
    state = JSON.parse(parseTextUI(await app.text()).blocks.get("workbench-state")!.value);
    expect(state.saved).toHaveLength(1); expect(parseTextUI(await app.text()).controls.get("query")?.value).toBe("hello");
  });

  it("uses semantic retrieval and pages the same ranked result set without re-embedding", async () => {
    const calls: string[] = [];
    const app = await harness(async kind => { calls.push(kind); return { indexReady: true, results: Array.from({ length: 13 }, (_, i) => ({ key: `note-${i}.md`, snippet: `chunk-${i}`, score: 1 - i / 100 })) }; });
    await app.edit({ query: "meaning", mode: "向量", search: true }); await workbenchApp.run(app.context);
    expect(calls).toEqual(["semantic"]);
    expect(parseTextUI(await app.text()).blocks.has("hit-0")).toBe(true);
    expect(parseTextUI(await app.text()).blocks.has("hit-5")).toBe(false);
    await app.edit({ next: true }); await workbenchApp.run(app.context);
    expect(parseTextUI(await app.text()).blocks.has("hit-5")).toBe(true);
    expect(parseTextUI(await app.text()).blocks.has("hit-0")).toBe(false);
    expect(calls).toEqual(["semantic"]);
    await app.edit({ prev: true }); await workbenchApp.run(app.context);
    expect(parseTextUI(await app.text()).blocks.has("hit-0")).toBe(true);
  });

  it("offers management health, explicit index refresh and index-only broken link checks", async () => {
    const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
    const app = await harness(async (kind, input) => {
      calls.push({ kind, input });
      if (kind === "stats") return { indexReady: true, documents: 10, staleDocuments: 2 };
      if (kind === "vector-health") return { ready: 8, owed: 2, bindings: { ai: true, vectorize: true } };
      if (kind === "graph") return { indexReady: true, edges: [{ from: "daily/one.md", link: "missing", dangling: true }, { from: "two.md", link: "one", dangling: false }] };
      return {};
    });
    await app.edit({ manage: true }); await workbenchApp.run(app.context);
    expect(await app.text()).toContain("向量就绪笔记");
    expect(calls.map(v => v.kind)).not.toContain("refresh");
    await app.edit({ "refresh-index": true }); await workbenchApp.run(app.context);
    expect(calls.map(v => v.kind)).toContain("refresh");
    await app.edit({ prefix: "daily", broken: true }); await workbenchApp.run(app.context);
    expect(calls.at(-1)?.input.prefix).toBe("");
    expect(parseTextUI(await app.text()).blocks.get("hit-0")?.value).toContain("missing");
  });

  it("matches exact registered filenames and refuses duplicate registrations", () => {
    expect(roomApps.match("games/workbench.ui.md")?.name).toBe("workbench");
    for (const path of ["search.md", "search.ui.md", "Workbench.ui.md", "unknown.ui.md", "workbench.ui.md.backup"]) expect(roomApps.match(path)).toBeUndefined();
    expect(() => new RoomAppRegistry().register(workbenchApp).register(workbenchApp)).toThrow("Duplicate");
  });

  it("renders the search route, searches by directory and restores the results route", async () => {
    const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
    const app = await harness(async (kind, input) => {
      calls.push({ kind, input });
      return { indexReady: true, results: [{ key: "daily/one.md", title: "One", snippet: "匹配片段" }] };
    });
    expect(await app.text()).toContain("知识库搜索");
    await app.edit({ query: "心率", prefix: "daily", search: true });
    await workbenchApp.run(app.context);
    expect(calls.at(-1)).toEqual({ kind: "search", input: { query: "心率", prefix: "daily/", limit: 200 } });
    const text = await app.text();
    expect(text).toContain("匹配片段");
    expect(text).toContain("obsidian://open?file=daily%2Fone");
    expect(JSON.parse(parseTextUI(text).blocks.get("workbench-state")!.value).route).toBe("/results");
    await workbenchApp.run(app.context);
    expect(await app.text()).toBe(text);
    await app.edit({ back: true });
    await workbenchApp.run(app.context);
    expect(JSON.parse(parseTextUI(await app.text()).blocks.get("workbench-state")!.value).route).toBe("/");
  });

  it("distinguishes unavailable, uninitialized and incomplete indexes", async () => {
    for (const [response, expected] of [[{ indexReady: false }, "尚未初始化"], [{ error: "broken" }, "不可用"], [{ indexReady: true, partial: true, staleDocuments: 3 }, "3 篇笔记待更新"]] as const) {
      const app = await harness(async () => response);
      await app.edit({ query: "hello", search: true });
      await workbenchApp.run(app.context);
      expect(await app.text()).toContain(expected);
    }
    const app = await harness(async () => { throw new Error("private upstream error"); });
    await app.edit({ query: "hello", search: true });
    await workbenchApp.run(app.context);
    expect(await app.text()).toContain("索引不可用");
    expect(await app.text()).not.toContain("private upstream error");
  });

  it("does not publish a late query after the draft changes or the app stops", async () => {
    let finish!: (result: Record<string, unknown>) => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const app = await harness(async kind => kind === "stats" ? { indexReady: true } : new Promise(resolve => { finish = resolve; started(); }));
    await app.edit({ query: "old", search: true });
    const task = workbenchApp.run(app.context);
    await begun;
    await app.edit({ query: "new" });
    const edited = await app.text();
    finish({ indexReady: true, results: [{ key: "old.md", snippet: "obsolete" }] });
    await task;
    expect(await app.text()).toBe(edited);
    await workbenchApp.run({ ...app.context, signal: AbortSignal.abort() });
    expect(await app.text()).toBe(edited);
    const port = new HotScreenPort("main", app.controller.signal, () => app.host.getScreen("main").then(value => value!), (text, options) => app.host.setScreen("main", text, options));
    app.controller.abort();
    await expect(port.setScreen("main", "late", { expectedRevision: (await app.host.getScreen("main"))!.revision })).rejects.toThrow("no longer active");
  });
});
