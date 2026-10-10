import { parseTextUI } from "@mineral/textui";
import type { RoomApp, RoomAppContext } from "../registry";
import { renderWorkbench } from "./view";

export const PAGE_SIZE = 5;
export type Mode = "全文" | "向量" | "文件名" | "最近" | "孤立" | "失效链接";
export type Hit = { key: string; title: string; snippet: string; score?: number };
type Draft = { query: string; prefix: string; mode: Mode };
export type WorkbenchState = {
  version: 2; route: "/" | "/results" | "/manage" | "/saved";
  requestId: string; phase: "idle" | "searching" | "done";
  query: string; prefix: string; mode: Mode; draft: Draft; page: number;
  status: string; results: Hit[]; history: Draft[]; saved: Hit[];
  health: { documents: number; stale: number; vectors: number; owed: number; vectorAvailable: boolean; ready: boolean; checked: string } | null;
};
const modes: Mode[] = ["全文", "向量", "文件名", "最近", "孤立", "失效链接"];
const defaults = (): WorkbenchState => ({ version: 2, route: "/", requestId: "", phase: "idle", query: "", prefix: "", mode: "全文", draft: { query: "", prefix: "", mode: "全文" }, page: 0, status: "正在检查索引…", results: [], history: [], saved: [], health: null });
function valid(value: unknown): value is WorkbenchState {
  if (!value || typeof value !== "object") return false;
  const s = value as WorkbenchState;
  const draft = (d: Draft) => !!d && typeof d.query === "string" && typeof d.prefix === "string" && typeof d.mode === "string";
  const hits = (h: Hit[], max: number) => Array.isArray(h) && h.length <= max && h.every(v => v && [v.key, v.title, v.snippet].every(x => typeof x === "string"));
  return s.version === 2 && ["/", "/results", "/manage", "/saved"].includes(s.route) && ["idle", "searching", "done"].includes(s.phase) &&
    [s.query, s.prefix, s.requestId, s.status].every(x => typeof x === "string") && modes.includes(s.mode) && draft(s.draft) &&
    Number.isInteger(s.page) && s.page >= 0 && hits(s.results, 200) && hits(s.saved, 50) && Array.isArray(s.history) && s.history.length <= 10 && s.history.every(draft);
}
function readControls(text: string) {
  const controls = parseTextUI(text).controls;
  for (const id of ["query", "prefix", "mode"]) if (controls.get(id)?.type !== "input") throw new Error("Missing workbench input");
  if (controls.get("search")?.type !== "action") throw new Error("Missing workbench action");
  const draft = { query: String(controls.get("query")!.value), prefix: String(controls.get("prefix")!.value), mode: String(controls.get("mode")!.value) as Mode };
  const actions = [...controls].filter(([, c]) => c.type === "action" && c.value === true).map(([id]) => id);
  return { draft, actions };
}
function status(data: Record<string, unknown>, mode: Mode): string {
  if (data.error) return mode === "向量" ? "向量索引不可用，无法回答；请在管理页检查服务和待更新数量。" : "索引不可用，无法回答搜索；请在管理页检查索引。";
  if (data.indexReady === false) return "索引尚未初始化，无法回答搜索；请先完成索引刷新。";
  if (mode === "向量") return `向量检索已完成；按相关度展示最多 50 个片段。向量更新可能有延迟${data.partial ? "，候选可能不完整" : ""}。`;
  return data.partial ? `索引可用，但结果可能不完整（${Number(data.staleDocuments ?? 0)} 篇笔记待更新）。` : "索引可用；结果来自已发布的全文索引。";
}
async function query(context: RoomAppContext, kind: string, input: Record<string, unknown> = {}) {
  try { return await context.index.query(kind, input); } catch { return { error: "index_unavailable" }; }
}
function normalizeHits(data: Record<string, unknown>, mode: Mode): Hit[] {
  if (data.error || data.indexReady === false) return [];
  let rows = data.results ?? data.hits ?? data.items ?? data.nodes;
  if (mode === "失效链接") rows = Array.isArray(data.edges) ? data.edges.filter((x: { dangling?: boolean }) => x.dangling).map((x: { from: string; link: string }) => ({ key: x.from, snippet: `未找到链接目标：${x.link}` })) : [];
  return Array.isArray(rows) ? rows.slice(0, mode === "向量" ? 50 : 200).flatMap(row => {
    if (!row || typeof row.key !== "string") return [];
    return [{ key: row.key, title: String(row.title ?? ""), snippet: String(row.snippet ?? (mode === "孤立" ? "没有连入或连出的笔记链接。" : row.modified ? `修改时间：${row.modified}` : "")).slice(0, 500), ...(typeof row.score === "number" && Number.isFinite(row.score) ? { score: row.score } : {}) }];
  }) : [];
}
export const workbenchApp: RoomApp = {
  name: "workbench",
  async run(context) {
    const { screen, screenId, signal } = context;
    if (signal.aborted) return;
    let snapshot = await screen.getScreen(screenId);
    if (!snapshot || signal.aborted) return;
    const stored = await context.state?.read();
    let embedded: unknown;
    try { embedded = JSON.parse(parseTextUI(snapshot.text).blocks.get("workbench-state")?.value ?? "null"); } catch { /* The server-owned checkpoint repairs damaged projection metadata. */ }
    let state = structuredClone(valid(stored) ? stored : valid(embedded) ? embedded : defaults());
    let draft = state.draft;
    let actions: string[] = [];
    let repair = false;
    try { ({ draft, actions } = readControls(snapshot.text)); } catch { repair = true; }
    const publish = async () => {
      if (signal.aborted) return;
      state.draft = draft;
      snapshot = await screen.setScreen(screenId, await renderWorkbench(state), { expectedRevision: snapshot!.revision, origin: "room-app:workbench" });
      if (!signal.aborted) await context.state?.write(state);
    };
    if (!valid(stored) && !valid(embedded)) {
      // Do not hold the mobile WebSocket upgrade on an index RPC just to paint the initial screen.
      state.status = "工作台已就绪；提交查询或打开管理页以检查索引。";
      repair = true;
    } else if (repair) state.status = "工作台界面已自动恢复；已提交的查询、收藏和历史保留。";
    if (repair) { draft = state.draft; await publish(); }
    if (signal.aborted) return;
    if (state.phase === "searching" && state.route === "/manage" && actions.length === 0) actions = ["manage"];
    if (state.phase === "searching" && state.route === "/results" && actions.length === 0 && JSON.stringify(draft) !== JSON.stringify(state.draft)) {
      state.phase = "idle"; state.requestId = ""; state.status = "输入已修改，请勾选搜索提交新查询。";
      await publish(); return;
    }

    if (actions.includes("next") || actions.includes("prev")) {
      state.page = Math.max(0, Math.min(Math.ceil(state.results.length / PAGE_SIZE) - 1, state.page + (actions.includes("next") ? 1 : -1)));
      await publish(); return;
    }
    if (actions.includes("back")) { state.route = "/"; state.phase = "idle"; state.requestId = ""; await publish(); return; }
    if (actions.includes("saved")) { state.route = "/saved"; state.phase = "idle"; state.requestId = ""; await publish(); return; }
    const bookmark = actions.find(id => /^bookmark-\d+$/.test(id));
    const remove = actions.find(id => /^remove-\d+$/.test(id));
    if (bookmark || remove) {
      const hit = state.results[Number(bookmark?.split("-")[1])];
      if (bookmark && hit && !state.saved.some(v => v.key === hit.key)) state.saved = [...state.saved, hit].slice(-50);
      if (remove) state.saved = state.saved.filter((_, index) => index !== Number(remove.split("-")[1]));
      await publish(); return;
    }
    const history = actions.find(id => /^history-\d+$/.test(id));
    if (history && state.history[Number(history.split("-")[1])]) { draft = { ...state.history[Number(history.split("-")[1])] }; actions = ["search"]; }
    const quick = actions.find(id => ["recent", "orphans", "broken"].includes(id));
    if (quick) { draft = { ...draft, mode: quick === "recent" ? "最近" : quick === "orphans" ? "孤立" : "失效链接" }; actions = ["search"]; }
    const manage = actions.includes("manage") || actions.includes("refresh-health") || actions.includes("refresh-index");
    if (manage) {
      state = { ...state, route: "/manage", phase: "searching", requestId: crypto.randomUUID(), status: actions.includes("refresh-index") ? "正在触发索引审计与刷新…" : "正在检查索引健康…" };
      await publish();
      const [stats, vector, refreshed] = await Promise.all([query(context, "stats"), query(context, "vector-health"), actions.includes("refresh-index") ? query(context, "refresh") : Promise.resolve(null)]);
      if (signal.aborted) return;
      const latest = await screen.getScreen(screenId);
      if (!latest || latest.revision !== snapshot.revision) return;
      const bindings = vector.bindings as { ai?: boolean; vectorize?: boolean } | undefined;
      state.health = { documents: Number(stats.documents ?? 0), stale: Number(stats.staleDocuments ?? 0), vectors: Number(vector.ready ?? vector.readyDocuments ?? 0), owed: Number(vector.owed ?? 0), vectorAvailable: !vector.error && !!bindings?.ai && !!bindings?.vectorize, ready: !stats.error && stats.indexReady !== false, checked: new Date().toISOString() };
      state.phase = "done";
      state.status = refreshed ? refreshed.error ? "索引刷新失败，请稍后重试。" : "索引刷新已执行；向量发布和检索可见性可能稍后完成。" : status(stats, "全文");
      await publish(); return;
    }
    if (actions.includes("search")) {
      const q = draft.query.trim(), prefix = draft.prefix.trim().replace(/\\/g, "/").replace(/\/+$/, "");
      if (!modes.includes(draft.mode) || q.length > 512 || (!["最近", "孤立", "失效链接"].includes(draft.mode) && !q) || prefix.length > 512 || prefix.startsWith("/") || prefix.split("/").some(v => v === "." || v === "..")) {
        state.status = "请填写 1–512 字的查询、正确的模式和知识库内的相对目录。"; state.phase = "done"; await publish(); return;
      }
      state = { ...state, query: q, prefix: prefix ? prefix + "/" : "", mode: draft.mode, page: 0, results: [], route: "/results", phase: "searching", requestId: crypto.randomUUID(), status: "正在查询服务器索引…", history: [{ ...draft }, ...state.history.filter(v => JSON.stringify(v) !== JSON.stringify(draft))].slice(0, 10) };
      await publish();
    }
    if (state.phase !== "searching" || state.route !== "/results") { await publish(); return; }
    const result = await query(context, state.mode === "向量" ? "semantic" : state.mode === "文件名" ? "filename-search" : state.mode === "最近" ? "recent" : ["孤立", "失效链接"].includes(state.mode) ? "graph" : "search", {
      query: state.query, prefix: state.mode === "失效链接" ? "" : state.prefix, limit: state.mode === "向量" ? 50 : 200, ...(state.mode === "孤立" ? { operation: "orphans", mode: "isolated" } : {}),
    });
    if (signal.aborted) return;
    const latest = await screen.getScreen(screenId);
    if (!latest || latest.revision !== snapshot.revision) return;
    state.results = normalizeHits(result, state.mode);
    if (state.mode === "失效链接" && state.prefix) state.results = state.results.filter(v => v.key.startsWith(state.prefix));
    state.status = status(result, state.mode); state.phase = "done";
    await publish();
  },
};
