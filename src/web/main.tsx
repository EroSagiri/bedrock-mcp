import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import MarkdownIt from "markdown-it";
import obsidianCallouts from "markdown-it-obsidian-callouts";
import taskLists from "markdown-it-task-lists";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Columns2,
  Edit3,
  Eye,
  FileText,
  Folder,
  GitFork,
  History,
  LogOut,
  Network,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Search,
  Tags,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import "./styles.css";

type DocumentItem = {
  key: string;
  title: string;
  folder: string;
  size: number;
  modified: string;
  modifiedRelative: string;
};
type LoadedDocument = { key: string; content: string; modified: string; etag?: string | null; size: number };
type SaveResult = { key: string; modified: string; etag?: string | null; size: number };
type RenameResult = LoadedDocument & { updatedLinks: Array<{ key: string; backupKey: string }> };
type CreateResult = LoadedDocument & { ok: boolean };
type ConflictError = Error & { current?: LoadedDocument };
type TagItem = { tag: string; count: number };
type FolderItem = { folder: string; count: number; lastModifiedRelative: string };
type GraphNode = { key: string; title: string; inDegree: number; outDegree: number; tags: string[] };
type GraphEdge = { from: string; to: string | null; link: string; dangling: boolean };
type GraphData = { nodeCount: number; edgeCount: number; danglingCount: number; nodes: GraphNode[]; edges: GraphEdge[] };
type HistoryItem = { backupKey: string; createdAt: string | null; size: number; modified: string; modifiedRelative: string };
type LeftMode = "files" | "search";
type ViewMode = "edit" | "split" | "preview";
type TreeFolder = { type: "folder"; name: string; path: string; children: TreeNode[]; count: number };
type TreeFile = { type: "file"; item: DocumentItem };
type TreeNode = TreeFolder | TreeFile;

const STATIC_EXT_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp|pdf|mp3|mp4|mov|webm|wav)$/i;
const IMAGE_EXT_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const AUTO_SAVE_DELAY_MS = 3000;
const REMOTE_POLL_MS = 15000;
const PROPERTY_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

function obsidianMarkdownPlugin(md: MarkdownIt) {
  md.core.ruler.before("normalize", "obsidian_wikilinks_and_embeds", state => {
    state.src = state.src
      .replace(/!\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (full, rawTarget: string, alias?: string) => {
        const target = rawTarget.trim();
        const text = alias?.trim() || target.split("/").pop() || target;
        if (!IMAGE_EXT_RE.test(target)) return `[${text}](wiki://${encodeURIComponent(target)})`;
        return `![${text}](${target})`;
      })
      .replace(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (_full, rawTarget: string, alias?: string) => {
        const target = rawTarget.trim();
        const text = alias?.trim() || target;
        return `[${text}](wiki://${encodeURIComponent(target)})`;
      });
  });
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
})
  .use(obsidianMarkdownPlugin)
  .use(obsidianCallouts)
  .use(taskLists, { enabled: false, label: true, labelAfter: true });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : `Request failed: ${response.status}`;
    const error = new Error(message) as ConflictError;
    if (response.status === 409 && typeof data === "object" && data !== null && "current" in data) {
      error.current = (data as { current: LoadedDocument }).current;
    }
    throw error;
  }
  return data as T;
}

function isExternalUrl(value: string): boolean {
  return /^(https?:|mailto:|tel:|data:|blob:|#|\/api\/|\/mcp|\/static\/)/i.test(value);
}

function resolveAssetUrl(value: string, docKey?: string): string {
  if (!value || isExternalUrl(value)) return value;
  const decoded = value.replace(/^\.?\//, "");
  const baseFolder = docKey?.includes("/") ? docKey.slice(0, docKey.lastIndexOf("/") + 1) : "";
  const key = decoded.startsWith("bedrock/") ? decoded : `${baseFolder}${decoded}`;
  return `/static/${encodeURI(key)}`;
}

function cleanPropertyValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parsePropertyList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(cleanPropertyValue).filter(Boolean);
  }
  return [cleanPropertyValue(trimmed)];
}

function parsePropertyLines(lines: string[]): Record<string, string[]> {
  const properties: Record<string, string[]> = {};
  let currentKey = "";
  for (const line of lines) {
    const match = PROPERTY_KEY_RE.exec(line);
    if (match) {
      currentKey = match[1];
      properties[currentKey] = parsePropertyList(match[2]);
      continue;
    }
    const listMatch = /^\s*(?:-\s*)?(.+?)\s*$/.exec(line);
    if (currentKey && listMatch?.[1]) {
      properties[currentKey].push(cleanPropertyValue(listMatch[1]));
    }
  }
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value.length));
}

function extractProperties(content: string): { properties: Record<string, string[]>; body: string } {
  if (content.startsWith("---")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    if (match) {
      return {
        properties: parsePropertyLines(match[1].split(/\r?\n/).filter(line => line.trim())),
        body: content.slice(match[0].length),
      };
    }
  }

  const lines = content.split(/\r?\n/);
  const propertyLines: string[] = [];
  let index = 0;
  let hasProperty = false;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      const next = lines[index + 1] ?? "";
      if (!hasProperty || !/^\s+(?:-\s*)?\S/.test(next)) break;
      propertyLines.push(line);
      index++;
      continue;
    }
    if (PROPERTY_KEY_RE.test(line) || (hasProperty && /^\s+(?:-\s*)?\S/.test(line))) {
      propertyLines.push(line);
      hasProperty = hasProperty || PROPERTY_KEY_RE.test(line);
      index++;
      continue;
    }
    break;
  }
  if (!hasProperty) return { properties: {}, body: content };
  return {
    properties: parsePropertyLines(propertyLines.filter(line => line.trim())),
    body: lines.slice(index).join("\n").replace(/^\n+/, ""),
  };
}

function renderMarkdown(content: string, docKey?: string): string {
  const raw = markdown.render(extractProperties(content).body);
  const template = document.createElement("template");
  template.innerHTML = raw;
  for (const img of template.content.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", resolveAssetUrl(src, docKey));
    img.setAttribute("loading", "lazy");
  }
  for (const anchor of template.content.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href?.startsWith("wiki://")) anchor.setAttribute("data-wiki", decodeURIComponent(href.slice("wiki://".length)));
    if (href && STATIC_EXT_RE.test(href) && !isExternalUrl(href)) anchor.setAttribute("href", resolveAssetUrl(href, docKey));
  }
  return template.innerHTML;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="loginShell">
      <form className="loginPanel" onSubmit={submit}>
        <div><h1>Bedrock Vault</h1><p>Sign in to edit your markdown vault.</p></div>
        <label><span>Admin password</span><input autoFocus type="password" value={password} onChange={e => setPassword(e.currentTarget.value)} placeholder="ADMIN_PASSWORD" /></label>
        {error && <p className="errorText">{error}</p>}
        <button className="primaryButton" disabled={busy || !password}>{busy ? "Signing in" : "Sign in"}</button>
      </form>
    </main>
  );
}

function buildFileTree(documents: DocumentItem[]): TreeFolder {
  const root: TreeFolder = { type: "folder", name: "Files", path: "", children: [], count: 0 };
  const folders = new Map<string, TreeFolder>([["", root]]);

  function getFolder(parts: string[]): TreeFolder {
    let path = "";
    let parent = root;
    for (const name of parts) {
      path += `${name}/`;
      let folder = folders.get(path);
      if (!folder) {
        folder = { type: "folder", name, path, children: [], count: 0 };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    return parent;
  }

  for (const item of documents) {
    const parts = item.key.split("/");
    const filename = parts.pop();
    if (!filename) continue;
    const folder = getFolder(parts);
    folder.children.push({ type: "file", item });
    for (let i = 0; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      const folderPath = path ? `${path}/` : "";
      const current = folders.get(folderPath);
      if (current) current.count++;
    }
  }

  function sortFolder(folder: TreeFolder) {
    folder.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      const left = a.type === "folder" ? a.name : a.item.title;
      const right = b.type === "folder" ? b.name : b.item.title;
      return left.localeCompare(right);
    });
    for (const child of folder.children) if (child.type === "folder") sortFolder(child);
  }
  sortFolder(root);
  return root;
}

function FileTree({
  documents,
  activeKey,
  collapsed,
  openDocument,
  toggleFolder,
  renameDocument,
  deleteDocument,
}: {
  documents: DocumentItem[];
  activeKey: string;
  collapsed: Set<string>;
  openDocument: (key: string) => void;
  toggleFolder: (folder: string) => void;
  renameDocument: (key: string) => void;
  deleteDocument: (key: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(documents), [documents]);
  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    if (node.type === "folder") {
      const isCollapsed = collapsed.has(node.path);
      return (
        <section key={node.path || "root"} className="treeFolder">
          {node.path && (
            <button className="folderRow" style={{ "--depth": depth } as React.CSSProperties} onClick={() => toggleFolder(node.path)}>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Folder size={14} />
              <span>{node.name}</span>
              <small>{node.count}</small>
            </button>
          )}
          {!isCollapsed && node.children.map(child => renderNode(child, node.path ? depth + 1 : depth))}
        </section>
      );
    }
    const item = node.item;
    return (
      <div key={item.key} className={item.key === activeKey ? "treeItem active" : "treeItem"} style={{ "--depth": depth } as React.CSSProperties}>
        <button className="treeOpenButton" onClick={() => openDocument(item.key)}>
          <FileText size={15} />
          <span><strong>{item.title}</strong><small>{item.modifiedRelative}</small></span>
        </button>
        <div className="treeActions">
          <button title="Rename" onClick={() => renameDocument(item.key)}><Edit3 size={14} /></button>
          <button title="Delete" onClick={() => deleteDocument(item.key)}><Trash2 size={14} /></button>
        </div>
      </div>
    );
  }
  return (
    <nav className="fileTree">
      {tree.children.map(child => renderNode(child, 0))}
      {!tree.children.length && <p className="mutedText treeEmpty">No files</p>}
    </nav>
  );
}

function GraphView({ graph, activeKey, openDocument, full = false }: { graph: GraphData | null; activeKey: string; openDocument: (key: string) => void; full?: boolean }) {
  const view = full ? { w: 960, h: 620, r: 250 } : { w: 300, h: 260, r: 96 };
  const nodes = useMemo(() => {
    if (!graph?.nodes.length) return [];
    const sorted = [...graph.nodes].sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree));
    const selected = activeKey ? sorted.filter(n => n.key === activeKey || graph.edges.some(e =>
      (e.from === activeKey && e.to === n.key) || (e.to === activeKey && e.from === n.key)
    )) : sorted.slice(0, full ? 80 : 18);
    const items = full ? sorted.slice(0, 120) : selected.slice(0, 24);
    return items.map((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(items.length, 1);
      const center = node.key === activeKey;
      return {
        ...node,
        x: view.w / 2 + Math.cos(angle) * (center ? 0 : view.r),
        y: view.h / 2 + Math.sin(angle) * (center ? 0 : view.r),
        radius: center ? 9 : Math.min(8, 4 + node.inDegree + node.outDegree),
      };
    });
  }, [graph, activeKey, full]);
  const nodeKeys = new Set(nodes.map(n => n.key));
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const edges = (graph?.edges ?? []).filter(e => nodeKeys.has(e.from) && e.to && nodeKeys.has(e.to));
  return (
    <div className={full ? "graphCanvas full" : "graphCanvas"}>
      <svg viewBox={`0 0 ${view.w} ${view.h}`} role="img">
        {edges.map(edge => {
          const from = byKey.get(edge.from);
          const to = edge.to ? byKey.get(edge.to) : null;
          if (!from || !to) return null;
          return <line key={`${edge.from}-${edge.to}-${edge.link}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edge.dangling ? "dangling" : ""} />;
        })}
        {nodes.map(node => (
          <g key={node.key} onClick={() => openDocument(node.key)} className={node.key === activeKey ? "graphNode active" : "graphNode"}>
            <circle cx={node.x} cy={node.y} r={node.radius} />
            <text x={node.x + 9} y={node.y + 4}>{node.title}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [leftMode, setLeftMode] = useState<LeftMode>("files");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [tags, setTags] = useState<TagItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [globalGraph, setGlobalGraph] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [conflict, setConflict] = useState<LoadedDocument | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const skipHistoryRef = useRef(false);

  const dirty = doc ? draft !== doc.content : false;
  const html = useMemo(() => ({ __html: renderMarkdown(draft, doc?.key) }), [draft, doc?.key]);
  const properties = useMemo(() => extractProperties(draft).properties, [draft]);
  const propertyEntries = useMemo(() => Object.entries(properties), [properties]);
  const backlinks = useMemo(() => graph?.edges.filter(e => e.to === activeKey).map(e => e.from) ?? [], [graph, activeKey]);
  const outgoing = useMemo(() => graph?.edges.filter(e => e.from === activeKey).map(e => e.to ?? e.link) ?? [], [graph, activeKey]);
  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter(item => item.key.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle));
  }, [documents, query]);

  function resolveWikiTarget(target: string): string | null {
    const clean = target.replace(/\.(md|markdown|mdx|txt)$/i, "");
    return documents.find(item =>
      item.key === target ||
      item.key === `${target}.md` ||
      item.key.replace(/\.(md|markdown|mdx|txt)$/i, "") === clean ||
      (item.key.split("/").pop() ?? "").replace(/\.(md|markdown|mdx|txt)$/i, "") === clean
    )?.key ?? null;
  }

  function setDraftWithHistory(next: string) {
    setDraft(current => {
      if (!skipHistoryRef.current && current !== next) {
        setUndoStack(stack => [...stack.slice(-99), current]);
        setRedoStack([]);
      }
      skipHistoryRef.current = false;
      return next;
    });
  }
  function replaceDraft(next: string) { skipHistoryRef.current = true; setDraft(next); }
  function undo() {
    setUndoStack(stack => {
      if (!stack.length) return stack;
      const previous = stack[stack.length - 1];
      setRedoStack(next => [...next.slice(-99), draft]);
      replaceDraft(previous);
      return stack.slice(0, -1);
    });
  }
  function redo() {
    setRedoStack(stack => {
      if (!stack.length) return stack;
      const nextValue = stack[stack.length - 1];
      setUndoStack(next => [...next.slice(-99), draft]);
      replaceDraft(nextValue);
      return stack.slice(0, -1);
    });
  }
  function toggleFolder(folder: string) {
    setCollapsedFolders(current => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }
  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${draft.slice(0, start)}  ${draft.slice(end)}`;
    setDraftWithHistory(next);
    window.requestAnimationFrame(() => {
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
    });
  }

  async function refreshLists(): Promise<DocumentItem[]> {
    const [docs, tagData, folderData, graphData] = await Promise.all([
      api<{ items: DocumentItem[] }>("/api/documents?limit=500"),
      api<{ tags: TagItem[] }>("/api/tags"),
      api<{ folders: FolderItem[] }>("/api/folders"),
      api<GraphData>("/api/graph"),
    ]);
    setDocuments(docs.items);
    setTags(tagData.tags);
    setFolders(folderData.folders);
    setGraph(graphData);
    if (!activeKey && docs.items[0]) void openDocument(docs.items[0].key);
    return docs.items;
  }
  async function refresh() {
    setBusy(true);
    try { await refreshLists(); } catch (err) { setStatus(err instanceof Error ? err.message : "Refresh failed"); } finally { setBusy(false); }
  }
  async function loadHistory(key: string) {
    const result = await api<{ items: HistoryItem[] }>(`/api/document/history?key=${encodeURIComponent(key)}`);
    setHistory(result.items);
  }
  async function openDocument(key: string) {
    const loaded = await api<LoadedDocument>(`/api/document?key=${encodeURIComponent(key)}`);
    setActiveKey(key);
    setDoc(loaded);
    replaceDraft(loaded.content);
    setUndoStack([]);
    setRedoStack([]);
    setConflict(null);
    setStatus("Synced");
    void loadHistory(key);
  }
  async function saveDocument(force = false) {
    if (!doc || saving) return;
    setSaving(true);
    try {
      const saved = await api<SaveResult>("/api/document", {
        method: "PUT",
        body: JSON.stringify({ key: doc.key, content: draft, baseEtag: doc.etag, baseModified: doc.modified, force }),
      });
      setDoc({ ...doc, content: draft, modified: saved.modified, etag: saved.etag, size: saved.size });
      setConflict(null);
      setStatus(force ? "Overwrote remote" : "Saved");
      await Promise.all([refreshLists(), loadHistory(doc.key)]);
    } catch (err) {
      const conflictError = err as ConflictError;
      if (conflictError.current) {
        setConflict(conflictError.current);
        setSyncEnabled(false);
        setStatus("Remote changed; autosave paused");
      } else {
        setStatus(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }
  async function createDocument() {
    const activeFolder = activeKey.includes("/") ? activeKey.slice(0, activeKey.lastIndexOf("/") + 1) : "";
    const suggested = `${activeFolder}Untitled.md`;
    const key = window.prompt("New note path", suggested)?.trim();
    if (!key) return;
    if (!/\.(md|markdown|mdx|txt)$/i.test(key)) {
      setStatus("New note must use a text extension");
      return;
    }
    setBusy(true);
    try {
      const title = (key.split("/").pop() ?? key).replace(/\.[^.]+$/, "");
      const created = await api<CreateResult>("/api/document/create", {
        method: "POST",
        body: JSON.stringify({ key, content: `# ${title}\n\n` }),
      });
      await refreshLists();
      setActiveKey(created.key);
      setDoc(created);
      replaceDraft(created.content);
      setHistory([]);
      setUndoStack([]);
      setRedoStack([]);
      setConflict(null);
      setStatus("Created note");
      void loadHistory(created.key);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }
  async function acceptRemote() {
    if (!conflict) return;
    setDoc(conflict);
    replaceDraft(conflict.content);
    setConflict(null);
    setSyncEnabled(true);
    setUndoStack([]);
    setRedoStack([]);
    setStatus("Loaded remote");
    await loadHistory(conflict.key);
  }
  async function restoreBackup(item: HistoryItem) {
    if (!doc) return;
    setBusy(true);
    try {
      const restored = await api<LoadedDocument>("/api/document/restore", {
        method: "POST",
        body: JSON.stringify({ key: doc.key, backupKey: item.backupKey }),
      });
      setDoc(restored);
      replaceDraft(restored.content);
      setConflict(null);
      setStatus("Restored history");
      await Promise.all([refreshLists(), loadHistory(restored.key)]);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  }
  async function renameDocument(key: string) {
    const nextKey = window.prompt("Rename note", key)?.trim();
    if (!nextKey || nextKey === key) return;
    if (!/\.(md|markdown|mdx|txt)$/i.test(nextKey)) {
      setStatus("Rename must keep a text extension");
      return;
    }
    setBusy(true);
    try {
      const renamed = await api<RenameResult>("/api/document/rename", {
        method: "POST",
        body: JSON.stringify({ from: key, to: nextKey, updateLinks: true }),
      });
      await refreshLists();
      setStatus(`Renamed and updated ${renamed.updatedLinks.length} linked notes`);
      if (activeKey === key) {
        setActiveKey(renamed.key);
        setDoc(renamed);
        replaceDraft(renamed.content);
        setUndoStack([]);
        setRedoStack([]);
        void loadHistory(renamed.key);
      } else if (renamed.updatedLinks.some(item => item.key === activeKey)) {
        await openDocument(activeKey);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }
  async function deleteDocument(key: string) {
    if (!window.confirm(`Move to trash?\n\n${key}`)) return;
    setBusy(true);
    try {
      await api("/api/document/delete", {
        method: "POST",
        body: JSON.stringify({ key, permanent: false }),
      });
      if (activeKey === key) {
        setActiveKey("");
        setDoc(null);
        replaceDraft("");
        setHistory([]);
        setUndoStack([]);
        setRedoStack([]);
      }
      const items = await refreshLists();
      setStatus("Moved to trash");
      if (activeKey === key && items[0]) await openDocument(items[0].key);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }
  async function openToday() {
    setBusy(true);
    try {
      const daily = await api<{ key: string; created: boolean }>("/api/daily", { method: "POST", body: JSON.stringify({}) });
      await refreshLists();
      await openDocument(daily.key);
      setStatus(daily.created ? "Created daily note" : "Opened daily note");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Daily note failed");
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setAuthenticated(false);
  }

  useEffect(() => {
    api<{ authenticated: boolean }>("/api/session").then(session => {
      setAuthenticated(session.authenticated);
      if (session.authenticated) void refresh();
    }).catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (!doc || !dirty || !syncEnabled || conflict || saving) return;
    const timer = window.setTimeout(() => void saveDocument(false), AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [doc?.key, draft, dirty, syncEnabled, conflict, saving]);
  useEffect(() => {
    if (!doc || conflict) return;
    const timer = window.setInterval(async () => {
      try {
        const remote = await api<LoadedDocument>(`/api/document?key=${encodeURIComponent(doc.key)}`);
        if (remote.etag === doc.etag && remote.modified === doc.modified) return;
        if (draft === doc.content) {
          setDoc(remote);
          replaceDraft(remote.content);
          setStatus("Pulled remote");
          void loadHistory(remote.key);
        } else {
          setConflict(remote);
          setSyncEnabled(false);
          setStatus("Remote changed; autosave paused");
        }
      } catch { setStatus("Remote sync check failed"); }
    }, REMOTE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [doc, draft, conflict]);

  if (authenticated === null) return <main className="loading">Loading</main>;
  if (!authenticated) return <Login onLogin={() => { setAuthenticated(true); void refresh(); }} />;

  return (
    <main className="obsidianShell">
      <aside className="leftPane">
        <div className="navRail" aria-label="Vault navigation">
          <button className={leftMode === "files" ? "active" : ""} onClick={() => setLeftMode("files")} title="Files"><Folder size={19} /></button>
          <button className={leftMode === "search" ? "active" : ""} onClick={() => setLeftMode("search")} title="Search"><Search size={19} /></button>
          <button onClick={() => void saveDocument(false)} title="Manual sync" disabled={!doc || !dirty || saving}><Save size={19} /></button>
          <button onClick={openToday} title="Open or create today's daily note" disabled={busy}><CalendarDays size={19} /></button>
        </div>
        <div className="leftContent">
          <header className="brand">
            <div><h1>Bedrock Vault</h1><span>{documents.length} notes</span></div>
            <button className="iconButton" onClick={logout} title="Sign out"><LogOut size={18} /></button>
          </header>
          <div className="toolbar">
            <label className="searchBox"><Search size={16} /><input value={query} onChange={e => setQuery(e.currentTarget.value)} placeholder={leftMode === "files" ? "Filter files" : "Search notes"} /></label>
            <button className="iconButton" onClick={() => void createDocument()} title="New note" disabled={busy}><Plus size={18} /></button>
            <button className="iconButton" onClick={refresh} title="Refresh" disabled={busy}><RefreshCw size={18} /></button>
          </div>
          {leftMode === "files" ? (
            <FileTree
              documents={searchResults}
              activeKey={activeKey}
              collapsed={collapsedFolders}
              openDocument={key => void openDocument(key)}
              toggleFolder={toggleFolder}
              renameDocument={key => void renameDocument(key)}
              deleteDocument={key => void deleteDocument(key)}
            />
          ) : (
            <nav className="documentList">
              {searchResults.map(item => <button key={item.key} className={item.key === activeKey ? "docItem active" : "docItem"} onClick={() => void openDocument(item.key)}><FileText size={16} /><span><strong>{item.title}</strong><small>{item.key}</small></span></button>)}
            </nav>
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="iconButton" onClick={() => setGlobalGraph(true)} title="Global graph"><Network size={17} /></button>
          <div className="titleBlock"><span>{doc?.key ?? "No note selected"}</span><strong>{saving ? "Saving" : status || (syncEnabled ? "Autosync on" : "Autosync paused")}</strong></div>
          <div className="actions">
            <button className="iconButton" onClick={undo} title="Undo" disabled={!undoStack.length}><Undo2 size={17} /></button>
            <button className="iconButton" onClick={redo} title="Redo" disabled={!redoStack.length}><Redo2 size={17} /></button>
            <div className="viewSwitch" aria-label="Markdown view mode">
              <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")} title="Edit"><Edit3 size={17} /></button>
              <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")} title="Split view"><Columns2 size={17} /></button>
              <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")} title="Reading view"><Eye size={17} /></button>
            </div>
            <button className="primaryButton" onClick={() => void saveDocument(false)} disabled={!doc || !dirty || saving}><Save size={17} /> Save</button>
          </div>
        </header>
        {conflict && <div className="conflictBanner"><span>Remote changed. Autosave paused to avoid overwriting another edit.</span><button onClick={acceptRemote}>Use remote</button><button onClick={() => void saveDocument(true)}>Overwrite remote</button></div>}
        <section className={`editorPane ${viewMode}`}>
          {(viewMode === "edit" || viewMode === "split") && (
            <div className="markdownEditor">
              <textarea
                value={draft}
                onChange={e => setDraftWithHistory(e.currentTarget.value)}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                placeholder="Choose or create a note"
              />
            </div>
          )}
          {(viewMode === "preview" || viewMode === "split") && (
            <article
              className="markdownPreview"
              onClick={event => {
                const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-wiki]");
                const target = link?.dataset.wiki;
                if (!target) return;
                event.preventDefault();
                const key = resolveWikiTarget(target);
                if (key) void openDocument(key);
                else setStatus(`Missing note: ${target}`);
              }}
            >
              {!!propertyEntries.length && (
                <section className="propertiesPanel" aria-label="Properties">
                  {propertyEntries.map(([key, values]) => (
                    <div key={key} className="propertyRow">
                      <span>{key}</span>
                      <div>
                        {values.map(value => (
                          key === "tags"
                            ? <button key={value} type="button">#{value.replace(/^#/, "")}</button>
                            : <strong key={value}>{value}</strong>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              <div dangerouslySetInnerHTML={html} />
            </article>
          )}
        </section>
      </section>

      <aside className="rightPane">
        <section>
          <h2><GitFork size={16} /> Local graph</h2>
          <GraphView graph={graph} activeKey={activeKey} openDocument={key => void openDocument(key)} />
        </section>
        <section>
          <h2>Links</h2>
          <div className="linkColumns">
            <div><strong>Backlinks</strong>{backlinks.slice(0, 12).map(key => <button key={key} onClick={() => void openDocument(key)}>{key}</button>)}</div>
            <div><strong>Outgoing</strong>{outgoing.slice(0, 12).map(key => <button key={key} onClick={() => { const resolved = resolveWikiTarget(key); if (resolved) void openDocument(resolved); }}>{key}</button>)}</div>
          </div>
        </section>
        <section>
          <h2><History size={16} /> History</h2>
          <div className="miniList">
            {history.slice(0, 8).map(item => <button key={item.backupKey} onClick={() => void restoreBackup(item)}><span>{item.createdAt ?? item.modified}</span><small>{item.modifiedRelative}</small></button>)}
            {!history.length && <p className="mutedText">No history yet</p>}
          </div>
        </section>
        <section>
          <h2><Tags size={16} /> Tags</h2>
          <div className="chips">{tags.slice(0, 24).map(tag => <button key={tag.tag}>{tag.tag}<span>{tag.count}</span></button>)}</div>
        </section>
      </aside>

      {globalGraph && (
        <div className="graphOverlay">
          <div className="graphModal">
            <header><div><h2>Global graph</h2><p>{graph?.nodeCount ?? 0} nodes, {graph?.edgeCount ?? 0} edges, {graph?.danglingCount ?? 0} dangling</p></div><button className="iconButton" onClick={() => setGlobalGraph(false)}><X size={18} /></button></header>
            <GraphView graph={graph} activeKey={activeKey} openDocument={key => { setGlobalGraph(false); void openDocument(key); }} full />
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
