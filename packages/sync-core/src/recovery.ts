import { isCanonicalVaultPath } from "./paths.js";
import { isSystemStorageKey, VERSION_NAMESPACE } from "./storage.js";
import { encodeTombstone, parseTombstone, tombstoneKey, tombstoneReadKeys, TOMBSTONE_NAMESPACE, TOMBSTONE_READ_NAMESPACES } from "./tombstones.js";
import { ensureDeleteTombstone, checkedAbsence, requestDeletes, type DeleteControl, type DeleteReceipt, type DeleteOutcome } from "./delete-tasks.js";
export { DirectDeleteStore, DELETE_TASK_NAMESPACE } from "./delete-tasks.js";
export type { DeleteControl, DeleteReceipt, DeleteOutcome } from "./delete-tasks.js";

export const DELETE_RISK = "R2 不支持可靠的条件 DELETE。验证 ETag 后到 DELETE 完成前，其他设备若重建同一路径，新内容仍可能被误删。删除前版本会保留，但该窗口内的新内容可能无法找回。";
export interface RecoveryObject { key: string; etag: string; size: number; modified: string; contentType: string; metadata: Record<string, string>; httpMetadata?: Record<string, string>; }
export interface RecoveryPort {
  list(prefix: string): Promise<RecoveryObject[]>;
  head(key: string, etag?: string): Promise<RecoveryObject | null>;
  read(key: string, etag: string): Promise<{ object: RecoveryObject; bytes: Uint8Array }>;
  put(key: string, bytes: Uint8Array, expected: string | null, metadata?: Record<string, string>, contentType?: string, httpMetadata?: Record<string, string>): Promise<RecoveryObject>;
  /** Unconditional R2 DELETE; callers validate immediately beforehand. */
  remove(key: string): Promise<void>;
  isPreconditionFailure?(error: unknown): boolean;
  removeMany?(keys: string[]): Promise<DeleteReceipt[]>;
  absent?(keys: string[]): Promise<Set<string>>;
}
export type RecoveryState = "backup" | "delete-pending" | "deleted" | "anomaly" | "migration" | "cleanup-pending";
export interface VersionManifest {
  version_id: string; path: string; deleted_etag: string; created_at: string; size: number;
  content_type: string; reason: "backup" | "delete" | "migration"; state: RecoveryState;
  content_etag: string; original_modified: string; original_metadata_json: string; original_http_metadata_json: string;
  anomaly: string;
}
export interface RecoveryEntry { kind: "version" | "legacy-version" | "tombstone" | "invalid"; key: string; etag: string; path: string; createdAt: string; size: number; reason: string; state: string; manifest?: VersionManifest; contentType?: string; recoverable?: boolean; error?: string; }
export interface RecoverySelection { key: string; etag: string; path: string; versionId?: string; }
export type RecoveryIntent = { identity: string; confirmed: true } & (
  | { action: "restore"; selection: RecoverySelection; target: string; expectedTargetETag: string | null }
  | { action: "clean"; selections: RecoverySelection[] }
  | { action: "delete"; path: string; etag: string }
  | { action: "migrate"; selection: RecoverySelection }
  | { action: "retry"; selection: RecoverySelection }
);

export function userPath(path: string): void {
  if (!isCanonicalVaultPath(path) || isSystemStorageKey(path)) throw new Error("Invalid ordinary file path");
}
export function versionKeys(id: string, path: string): { manifest: string; content: string; root: string } {
  userPath(path);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid version ID");
  const root = `${VERSION_NAMESPACE}${id}/`;
  return { root, manifest: `${root}manifest.toml`, content: `${root}content/${path}` };
}
function metadataJson(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== "string")) throw new Error("Invalid original metadata");
  return parsed as Record<string, string>;
}
export function validateManifest(m: VersionManifest): void {
  versionKeys(m.version_id, m.path);
  for (const key of ["deleted_etag", "content_etag", "content_type", "original_metadata_json", "original_http_metadata_json", "anomaly"] as const) if (typeof m[key] !== "string") throw new Error(`Invalid ${key}`);
  if (!m.content_etag || !m.deleted_etag || !Number.isSafeInteger(m.size) || m.size < 0 || !Number.isFinite(Date.parse(m.created_at)) || !Number.isFinite(Date.parse(m.original_modified))) throw new Error("Invalid version metadata");
  if (!["backup", "delete", "migration"].includes(m.reason) || !["backup", "delete-pending", "deleted", "anomaly", "migration", "cleanup-pending"].includes(m.state)) throw new Error("Invalid version state");
  metadataJson(m.original_metadata_json); metadataJson(m.original_http_metadata_json);
}
/** A deliberately restricted TOML schema: quoted strings and decimal size, no executable parsing. */
export function encodeManifest(m: VersionManifest): Uint8Array {
  validateManifest(m);
  return new TextEncoder().encode(Object.entries(m).map(([k, v]) => `${k} = ${typeof v === "number" ? v : JSON.stringify(v)}`).join("\n") + "\n");
}
export function parseManifest(bytes: Uint8Array): VersionManifest {
  if (bytes.byteLength > 128 * 1024) throw new Error("Manifest too large");
  const result: Record<string, string | number> = {};
  for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error("Malformed TOML manifest");
    const value: unknown = JSON.parse(match[2]);
    if (typeof value !== "string" && !(match[1] === "size" && typeof value === "number" && /^(0|[1-9]\d*)$/.test(match[2]))) throw new Error("Invalid TOML scalar");
    result[match[1]] = value as string | number;
  }
  const m = result as unknown as VersionManifest; validateManifest(m); return m;
}
const selectionOf = (e: RecoveryEntry): RecoverySelection => ({ key: e.key, etag: e.etag, path: e.path, ...(e.manifest ? { versionId: e.manifest.version_id } : {}) });
export { selectionOf as recoverySelection };

/** R2 is the only source. The engine has no Vault, gateway, or local mirror capability. */
export class RecoveryStore {
  constructor(private readonly port: RecoveryPort, readonly identity: string, private readonly now = () => new Date(), private readonly newId: () => string = () => crypto.randomUUID()) {}
  async list(): Promise<RecoveryEntry[]> {
    const output: RecoveryEntry[] = [];
    const objects = await this.port.list(VERSION_NAMESPACE);
    const groups = new Map<string, RecoveryObject[]>();
    for (const object of objects) {
      if (!object.key.startsWith(VERSION_NAMESPACE)) throw new Error("Listing escaped version namespace");
      const id = object.key.slice(VERSION_NAMESPACE.length).split("/")[0];
      groups.set(id, [...(groups.get(id) ?? []), object]);
    }
    // Read independent immutable groups in bounded batches; avoid one network round trip per row.
    const grouped = [...groups];
    for (let start = 0; start < grouped.length; start += 8) await Promise.all(grouped.slice(start, start + 8).map(async ([id, group]) => {
      const manifestKey = `${VERSION_NAMESPACE}${id}/manifest.toml`;
      const manifestObject = group.find(o => o.key === manifestKey);
      try {
        if (!manifestObject) {
          if (group.length !== 1) throw new Error("旧格式版本含多个对象，禁止猜测迁移");
          const old = group[0]; const path = old.key.slice(`${VERSION_NAMESPACE}${id}/`.length);
          if (path.startsWith("content/")) throw new Error("新格式正文缺少 manifest");
          const source = await this.legacy({ key: old.key, etag: old.etag, path }, group, true);
          output.push({ kind: "legacy-version", key: old.key, etag: old.etag, path, createdAt: source.object.modified, size: source.object.size, reason: "migration", state: "legacy-version" });
          return;
        }
        const m = parseManifest((await this.port.read(manifestKey, manifestObject.etag)).bytes);
        const keys = versionKeys(m.version_id, m.path);
        const body = group.find(o => o.key === keys.content);
        if (keys.manifest !== manifestKey || !(m.state === "cleanup-pending" && group.length === 1 && !body) && (group.length !== 2 || !body || body.etag !== m.content_etag || body.size !== m.size)) throw new Error("版本正文与 manifest 不完整或 ETag 不匹配");
        output.push({ kind: "version", key: manifestKey, etag: manifestObject.etag, path: m.path, createdAt: m.created_at, size: m.size, reason: m.reason, state: m.state, manifest: m });
      } catch (error) {
        output.push({ kind: "invalid", key: manifestKey, etag: manifestObject?.etag ?? "", path: group[0]?.metadata.sourcekey ?? group[0]?.metadata.sourceKey ?? id, createdAt: group[0]?.modified ?? "", size: group.reduce((n, o) => n + o.size, 0), reason: "migration", state: "invalid", error: String(error) });
      }
    }));
    for (const namespace of TOMBSTONE_READ_NAMESPACES) for (const object of await this.port.list(namespace)) {
      try {
        if (!object.key.startsWith(namespace)) throw new Error("Listing escaped tombstone namespace");
        const t = parseTombstone((await this.port.read(object.key, object.etag)).bytes);
        userPath(t.path);
        if (!(await tombstoneReadKeys(t.path, t.deletedRemoteETag)).includes(object.key)) throw new Error("Tombstone identity mismatch");
        const version = output.find(e => e.manifest?.path === t.path && e.manifest.deleted_etag === t.deletedRemoteETag);
        let size = version?.size ?? -1; let contentType = version?.manifest?.content_type; let recoverable = false;
        if (!version) {
          try { const original = await this.port.head(t.path, t.deletedRemoteETag); if (original && original.etag === t.deletedRemoteETag) { size = original.size; contentType = original.contentType; recoverable = true; } } catch { /* Metadata remains readable; a changed current file is never its deleted body. */ }
        }
        output.push({ kind: "tombstone", key: object.key, etag: object.etag, path: t.path, createdAt: t.createdAt, size, contentType, recoverable, reason: "delete", state: namespace === TOMBSTONE_NAMESPACE ? "tombstone" : "legacy-read-only" });
      } catch (error) { output.push({ kind: "invalid", key: object.key, etag: object.etag, path: object.key, createdAt: object.modified, size: object.size, reason: "delete", state: "invalid", error: String(error) }); }
    }
    return output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async observeTarget(path: string): Promise<RecoveryObject | null> { userPath(path); return this.port.head(path); }
  private async version(s: RecoverySelection, allowCleanedBody = false): Promise<{ m: VersionManifest; object: RecoveryObject; bytes: Uint8Array }> {
    if (!s.versionId || !s.etag) throw new Error("Missing version identity");
    const keys = versionKeys(s.versionId, s.path);
    if (s.key !== keys.manifest) throw new Error("Version selection escaped namespace");
    const manifest = await this.port.read(keys.manifest, s.etag);
    const m = parseManifest(manifest.bytes);
    if (m.path !== s.path || m.version_id !== s.versionId) throw new Error("Stale version identity");
    const group = await this.port.list(keys.root);
    if (allowCleanedBody && m.state === "cleanup-pending" && group.length === 1 && group[0].key === keys.manifest && group[0].etag === s.etag) return { m, object: manifest.object, bytes: new Uint8Array() };
    if (group.length !== 2 || !group.some(o => o.key === keys.manifest && o.etag === s.etag) || !group.some(o => o.key === keys.content && o.etag === m.content_etag && o.size === m.size)) throw new Error("Incomplete version group");
    const content = await this.port.read(keys.content, m.content_etag);
    if (content.bytes.byteLength !== m.size || content.object.etag !== m.content_etag) throw new Error("Version body changed");
    return { m, object: manifest.object, bytes: content.bytes };
  }
  private async legacy(s: RecoverySelection, listedGroup?: RecoveryObject[], metadataOnly = false): Promise<{ object: RecoveryObject; bytes: Uint8Array }> {
    userPath(s.path);
    if (!s.key.startsWith(VERSION_NAMESPACE) || !isCanonicalVaultPath(s.key) || !s.etag || s.versionId) throw new Error("Invalid legacy version selection");
    const remainder = s.key.slice(VERSION_NAMESPACE.length); const slash = remainder.indexOf("/");
    if (slash < 1 || remainder.slice(slash + 1) !== s.path || s.path.startsWith("content/") || s.path === "manifest.toml") throw new Error("Legacy path identity mismatch");
    const root = `${VERSION_NAMESPACE}${remainder.slice(0, slash)}/`;
    const group = listedGroup ?? await this.port.list(root);
    if (group.length !== 1 || group[0].key !== s.key || group[0].etag !== s.etag) throw new Error("Incomplete legacy version");
    const head = metadataOnly ? await this.port.head(s.key, s.etag) : undefined;
    if (metadataOnly && !head) throw new Error("Legacy version missing");
    const read = head ? { object: head, bytes: new Uint8Array() } : await this.port.read(s.key, s.etag);
    const source = read.object.metadata.sourcekey ?? read.object.metadata.sourceKey;
    if (source !== s.path) throw new Error("Legacy source metadata missing or mismatched");
    const metadata = read.object.metadata.mineraloriginalmetadata ?? read.object.metadata.mineralOriginalMetadata;
    if (metadata === undefined) throw new Error("Legacy original metadata missing");
    metadataJson(metadata); return read;
  }
  private async deletedBody(s: RecoverySelection): Promise<{ object: RecoveryObject; bytes: Uint8Array; createdAt: string }> {
    if (!TOMBSTONE_READ_NAMESPACES.some(prefix => s.key.startsWith(prefix)) || !s.etag) throw new Error("Invalid deleted-file selection");
    const t = parseTombstone((await this.port.read(s.key, s.etag)).bytes);
    userPath(t.path);
    if (t.path !== s.path || !(await tombstoneReadKeys(t.path, t.deletedRemoteETag)).includes(s.key)) throw new Error("Deleted-file identity mismatch");
    const current = await this.port.head(t.path, t.deletedRemoteETag);
    if (!current || current.etag !== t.deletedRemoteETag) throw new Error("旧正文已不存在或已改变，请选择版本副本恢复");
    return { ...await this.port.read(t.path, t.deletedRemoteETag), createdAt: t.createdAt };
  }
  async preview(s: RecoverySelection): Promise<Uint8Array> {
    return s.versionId ? (await this.version(s)).bytes : TOMBSTONE_READ_NAMESPACES.some(prefix => s.key.startsWith(prefix)) ? (await this.deletedBody(s)).bytes : (await this.legacy(s)).bytes;
  }
  private async archiveDeletedBody(s: RecoverySelection): Promise<void> {
    const source = await this.deletedBody(s); const id = this.newId(); const keys = versionKeys(id, s.path);
    const body = await this.port.put(keys.content, source.bytes, null, {}, source.object.contentType);
    const m: VersionManifest = { version_id: id, path: s.path, deleted_etag: source.object.etag, created_at: source.createdAt, size: source.bytes.byteLength, content_type: source.object.contentType, reason: "migration", state: "migration", content_etag: body.etag, original_modified: source.object.modified, original_metadata_json: JSON.stringify(source.object.metadata), original_http_metadata_json: JSON.stringify(source.object.httpMetadata ?? {}), anomaly: "" };
    await this.port.put(keys.manifest, encodeManifest(m), null, {}, "application/toml");
    // Preserve both the old tombstone and the ordinary body. Migration is not a DELETE capability.
  }
  private async migrate(s: RecoverySelection): Promise<void> {
    const old = await this.legacy(s); const id = this.newId(); const keys = versionKeys(id, s.path);
    const body = await this.port.put(keys.content, old.bytes, null, {}, old.object.contentType);
    const original = old.object.metadata.mineraloriginalmetadata ?? old.object.metadata.mineralOriginalMetadata;
    const sourceETag = old.object.metadata.sourceetag ?? old.object.metadata.sourceETag;
    const m: VersionManifest = { version_id: id, path: s.path, deleted_etag: sourceETag ?? old.object.etag, created_at: old.object.metadata.createdat ?? old.object.metadata.createdAt ?? old.object.modified, size: old.bytes.byteLength, content_type: old.object.contentType, reason: "migration", state: "migration", content_etag: body.etag, original_modified: old.object.modified, original_metadata_json: original!, original_http_metadata_json: JSON.stringify(old.object.httpMetadata ?? {}), anomaly: sourceETag ? "" : "legacy-source-etag-unavailable: deleted_etag records the archived object ETag" };
    const manifest = await this.port.put(keys.manifest, encodeManifest(m), null, {}, "application/toml");
    const copied = await this.version({ key: keys.manifest, etag: manifest.etag, path: s.path, versionId: id });
    if (copied.bytes.length !== old.bytes.length || copied.bytes.some((b, i) => b !== old.bytes[i])) throw new Error("Migration byte verification failed");
    await this.legacy(s); // Verify the old singleton again before physically retiring it.
    await this.port.remove(s.key);
    if (await this.port.head(s.key)) throw new Error("Legacy cleanup not confirmed");
  }
  async backup(path: string, etag: string, reason: VersionManifest["reason"] = "backup", id = this.newId()): Promise<RecoveryEntry> {
    userPath(path);
    const head = await this.port.head(path, etag);
    if (!head || head.etag !== etag) throw new Error("Source ETag changed");
    const read = await this.port.read(path, etag);
    if (read.object.etag !== etag || read.bytes.byteLength !== head.size) throw new Error("Source changed during read");
    const keys = versionKeys(id, path);
    // S3 HTTP metadata headers are ByteStrings. Keep Unicode paths in the TOML body;
    // the compatibility hint is explicitly URI encoded, and its JSON is ASCII escaped.
    const asciiPath = /^[\x20-\x7e]*$/.test(path);
    const metadataJSON = JSON.stringify(read.object.metadata).replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const body = await this.port.put(keys.content, read.bytes, null, { sourceKey: asciiPath ? path : encodeURIComponent(path), ...(asciiPath ? {} : { mineralSourceKeyEncoding: "uri" }), reason, mineralOriginalMetadata: metadataJSON }, read.object.contentType);
    const m: VersionManifest = { version_id: id, path, deleted_etag: etag, created_at: this.now().toISOString(), size: read.bytes.byteLength, content_type: read.object.contentType, reason, state: reason === "delete" ? "delete-pending" : reason, content_etag: body.etag, original_modified: read.object.modified, original_metadata_json: JSON.stringify(read.object.metadata), original_http_metadata_json: JSON.stringify(read.object.httpMetadata ?? {}), anomaly: reason === "delete" ? "delete-window-unverifiable: a concurrent recreation may be removed; only the pre-delete bytes are backed up" : "" };
    const manifest = await this.port.put(keys.manifest, encodeManifest(m), null, {}, "application/toml");
    return { kind: "version", key: keys.manifest, etag: manifest.etag, path, createdAt: m.created_at, size: m.size, reason, state: m.state, manifest: m };
  }
  private async state(s: RecoverySelection, m: VersionManifest, state: RecoveryState, anomaly = m.anomaly): Promise<void> {
    await this.port.put(s.key, encodeManifest({ ...m, state, anomaly }), s.etag, {}, "application/toml");
  }
  private async tombstone(path: string, etag: string, createdAt: string): Promise<void> {
    if (this.port.isPreconditionFailure) return ensureDeleteTombstone(this.port, path, etag, createdAt);
    const key = await tombstoneKey(path, etag);
    if (!key) throw new Error("Invalid tombstone identity");
    const existing = await this.port.head(key);
    if (existing) {
      const t = parseTombstone((await this.port.read(key, existing.etag)).bytes);
      if (t.path !== path || t.deletedRemoteETag !== etag) throw new Error("Tombstone mismatch");
      return;
    }
    await this.port.put(key, encodeTombstone({ protocol: 1, path, deletedRemoteETag: etag, createdAt }), null, {}, "application/json");
  }
  async deleteFile(path: string, etag: string, confirmed: boolean): Promise<{ state: RecoveryState; entry: RecoveryEntry }> {
    if (!confirmed) throw new Error("Explicit delete confirmation required");
    const entry = await this.backup(path, etag, "delete");
    const selection = selectionOf(entry);
    await this.tombstone(path, etag, entry.createdAt);
    // Only this private continuation may reuse the just-committed backup. Public retries
    // still re-read and validate the complete version selected by identity and ETag.
    const state = await this.finishDelete(selection, entry.manifest);
    return { state, entry };
  }
  /** Fresh backed-up deletions share the DELETE request and absence proof, never the backups. */
  async deleteFiles(files: { path: string; etag: string }[], control: DeleteControl = {}): Promise<DeleteOutcome[]> {
    const outcomes: DeleteOutcome[] = [];
    const ready: RecoveryEntry[] = [];
    await Promise.all(files.map(async file => {
      if (control.shouldContinue?.() === false) { outcomes.push({ path: file.path, state: "delete-pending" }); return; }
      try {
        const entry = await this.backup(file.path, file.etag, "delete");
        await this.tombstone(file.path, file.etag, entry.createdAt);
        ready.push(entry);
      } catch (error) {
        let changed = false;
        try { const current = await this.port.head(file.path); changed = !!current && current.etag !== file.etag; } catch { /* Unknown. */ }
        outcomes.push({ path: file.path, state: changed ? "conflict" : "delete-pending", error: String(error) });
      }
    }));
    const verified: RecoveryEntry[] = [];
    await Promise.all(ready.map(async entry => {
      try {
        const m = entry.manifest!;
        const current = await this.port.head(m.path, m.deleted_etag);
        if (!current) { await this.state(selectionOf(entry), m, "deleted"); outcomes.push({ path: m.path, state: "deleted" }); return; }
        if (current.etag !== m.deleted_etag || Math.floor(Date.parse(current.modified) / 1000) !== Math.floor(Date.parse(m.original_modified) / 1000)) throw Error("Source changed before DELETE");
        verified.push(entry);
      } catch (error) {
        let changed = false;
        try {
          const current = await this.port.head(entry.path), m = entry.manifest!;
          changed = !!current && (current.etag !== m.deleted_etag || Math.floor(Date.parse(current.modified) / 1000) !== Math.floor(Date.parse(m.original_modified) / 1000));
          if (changed) await this.state(selectionOf(entry), m, "anomaly", "source-recreated-before-delete");
        } catch { /* Unknown remains pending; a proven conflict remains a conflict. */ }
        outcomes.push({ path: entry.path, state: changed ? "conflict" : "delete-pending", error: String(error) });
      }
    }));
    if (control.shouldContinue?.() === false) return [...outcomes, ...verified.map(e => ({ path: e.path, state: "delete-pending" as const }))];
    if (!verified.length) return outcomes;
    const receipts = await requestDeletes(this.port, verified.map(e => e.path));
    const absent = await checkedAbsence(this.port, verified.map(e => e.path));
    await Promise.all(verified.map(async entry => {
      let state: DeleteOutcome["state"] = "delete-pending";
      if (absent.has(entry.path)) try { await this.state(selectionOf(entry), entry.manifest!, "deleted"); state = "deleted"; } catch { /* Durable pending manifest remains. */ }
      const receipt = receipts.find(r => r.key === entry.path);
      outcomes.push({ path: entry.path, state, request: receipt?.status ?? "missing", error: receipt?.error });
    }));
    return outcomes;
  }
  private async finishDelete(s: RecoverySelection, committed?: VersionManifest, control: DeleteControl = {}): Promise<RecoveryState> {
    const m = committed ?? (await this.version(s)).m;
    if (m.reason !== "delete" || m.state !== "delete-pending") throw new Error("Not a pending delete");
    // Recreate a missing tombstone only before DELETE, never infer that its absence permits deletion.
    if (!committed) await this.tombstone(m.path, m.deleted_etag, m.created_at);
    try {
      let current: RecoveryObject | null;
      try { current = await this.port.head(m.path, m.deleted_etag); }
      catch (error) {
        const observed = await this.port.head(m.path);
        if (observed && observed.etag !== m.deleted_etag) {
          await this.state(s, m, "anomaly", "source-recreated-before-delete"); return "anomaly";
        }
        throw error;
      }
      if (!current) { await this.state(s, m, "deleted"); return "deleted"; }
      // Worker uploaded timestamps have milliseconds; S3 Last-Modified has second precision.
      if (current.etag !== m.deleted_etag || Math.floor(Date.parse(current.modified) / 1000) !== Math.floor(Date.parse(m.original_modified) / 1000)) {
        await this.state(s, m, "anomaly", "source-recreated-before-delete"); return "anomaly";
      }
      // The acknowledged race window is recorded durably in the manifest before this call.
      if (control.shouldContinue?.() === false) return "delete-pending";
      await this.port.remove(m.path);
      const after = await this.port.head(m.path);
      if (after) { await this.state(s, m, "anomaly", `object-present-after-delete:${after.etag}`); return "anomaly"; }
      await this.state(s, m, "deleted"); return "deleted";
    } catch { return "delete-pending"; } // No rollback. The backup and tombstone remain authoritative.
  }
  async retryPending(control: DeleteControl = {}): Promise<number> {
    if (control.shouldContinue?.() === false) return 0;
    let count = 0;
    // Discovery needs manifests only, not every historical body and tombstone. The
    // selected pending version is fully revalidated by finishDelete before mutation.
    const manifests = (await this.port.list(VERSION_NAMESPACE)).filter(o => /^\.mineral\/versions\/[^/]+\/manifest\.toml$/.test(o.key));
    const width = control.concurrency ?? 4;
    for (let start = 0; start < manifests.length && control.shouldContinue?.() !== false; start += width) await Promise.all(manifests.slice(start, start + width).map(async object => {
      try {
        const m = parseManifest((await this.port.read(object.key, object.etag)).bytes);
        if (versionKeys(m.version_id, m.path).manifest !== object.key || m.reason !== "delete" || m.state !== "delete-pending") return;
        if (control.shouldContinue?.() === false) return;
        if (await this.finishDelete({ key: object.key, etag: object.etag, path: m.path, versionId: m.version_id }, undefined, control) !== "delete-pending") count++;
      } catch { /* Preserve damaged, raced, or unavailable records; retry on a later scan. */ }
    }));
    return count;
  }
  async execute(intent: RecoveryIntent): Promise<void> {
    if (intent.identity !== this.identity || intent.confirmed !== true) throw new Error("Stale recovery identity or missing confirmation");
    if (intent.action === "migrate") {
      if (TOMBSTONE_READ_NAMESPACES.some(prefix => intent.selection.key.startsWith(prefix))) await this.archiveDeletedBody(intent.selection);
      else await this.migrate(intent.selection);
      return;
    }
    if (intent.action === "delete") { const result = await this.deleteFile(intent.path, intent.etag, true); if (result.state !== "deleted") throw new Error(`删除待确认：${result.state}`); return; }
    if (intent.action === "retry") { const result = await this.finishDelete(intent.selection); if (result !== "deleted") throw new Error(`删除待确认：${result}`); return; }
    if (intent.action === "restore") {
      userPath(intent.target);
      const { m, bytes } = await this.version(intent.selection);
      const target = await this.port.head(intent.target);
      if ((target?.etag ?? null) !== intent.expectedTargetETag) throw new Error("Restore target changed; refresh and choose new name or explicitly overwrite");
      // Capture exact metadata identities before the write. Never sweep a later deletion created
      // by another client after this restore committed.
      const beforeRestore = (await this.list()).filter(e => e.path === intent.target);
      if (target) await this.backup(intent.target, target.etag);
      await this.port.put(intent.target, bytes, intent.expectedTargetETag, { ...metadataJson(m.original_metadata_json), mineral_restored_at: this.now().toISOString() }, m.content_type, metadataJson(m.original_http_metadata_json));
      for (const e of beforeRestore) if (e.kind === "version" && e.state === "delete-pending") {
        const prior = await this.version(selectionOf(e));
        await this.state(selectionOf(e), prior.m, "anomaly", "restored-by-user: previous pending delete retired");
      }
      // Restoring identical bytes can reproduce the old ETag. Retire current-namespace tombstones
      // after a successful write; legacy records remain read-only and use the restoration metadata.
      for (const e of beforeRestore) if (e.kind === "tombstone" && e.state !== "legacy-read-only") await this.cleanTombstone(selectionOf(e));
      return;
    }
    // Retiring a pending deletion's tombstone could make its surviving old body live again.
    const pending = new Set((await this.list()).filter(e => e.kind === "version" && e.state === "delete-pending").map(e => e.path));
    if (intent.selections.some(s => pending.has(s.path))) throw new Error("删除待确认，请先完成真实删除，再清理恢复记录");
    // Preflight the entire batch before touching any group. Fail closed on damaged records.
    for (const s of intent.selections) {
      if (s.versionId) { const v = await this.version(s, true); if (v.m.state === "delete-pending") throw new Error("Pending delete must be verified before cleanup"); } else await this.readTombstone(s);
    }
    for (const s of intent.selections) {
      if (!s.versionId) { await this.cleanTombstone(s); continue; }
      const { m } = await this.version(s, true);
      if (m.state === "delete-pending") throw new Error("Pending delete must be verified before cleanup");
      const keys = versionKeys(s.versionId, s.path);
      // Persist the authorized group cleanup before removing either member. A partial group can
      // only resume under this state; an originally missing/corrupt body still fails preflight.
      let manifestETag = s.etag;
      if (m.state !== "cleanup-pending") {
        const updated = await this.port.put(keys.manifest, encodeManifest({ ...m, state: "cleanup-pending" }), s.etag, {}, "application/toml");
        manifestETag = updated.etag;
      }
      const [body, manifest] = await Promise.all([this.port.head(keys.content, m.content_etag), this.port.head(keys.manifest, manifestETag)]);
      if (!manifest || manifest.etag !== manifestETag || body && body.etag !== m.content_etag || !body && m.state !== "cleanup-pending") throw new Error("Version changed before cleanup");
      if (body) await this.port.remove(keys.content);
      if (await this.port.head(keys.content)) throw new Error("Version content DELETE not confirmed");
      const verifiedManifest = await this.port.head(keys.manifest, manifestETag);
      if (!verifiedManifest || verifiedManifest.etag !== manifestETag) throw new Error("Manifest changed before cleanup");
      await this.port.remove(keys.manifest);
      if (await this.port.head(keys.manifest)) throw new Error("Manifest DELETE not confirmed");
    }
  }
  private async readTombstone(s: RecoverySelection): Promise<void> {
    if (!s.key.startsWith(TOMBSTONE_NAMESPACE) || !s.etag) throw new Error("Only .mineral/tombstones metadata may be cleaned; legacy is read-only");
    const t = parseTombstone((await this.port.read(s.key, s.etag)).bytes);
    userPath(t.path);
    if (t.path !== s.path || await tombstoneKey(t.path, t.deletedRemoteETag) !== s.key) throw new Error("Tombstone identity mismatch");
  }
  private async cleanTombstone(s: RecoverySelection): Promise<void> {
    await this.readTombstone(s);
    const head = await this.port.head(s.key, s.etag);
    if (!head || head.etag !== s.etag) throw new Error("Tombstone changed before cleanup");
    await this.port.remove(s.key); // Never delete the current ordinary object through tombstone cleanup.
    if (await this.port.head(s.key)) throw new Error("Tombstone DELETE not confirmed");
  }
}
