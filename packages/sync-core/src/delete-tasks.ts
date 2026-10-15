import type { RecoveryPort } from "./recovery.js";
import { userPath } from "./recovery.js";
import { encodeTombstone, parseTombstone, tombstoneKey } from "./tombstones.js";

export interface DeleteControl { concurrency?: 1 | 4; shouldContinue?: () => boolean; }
export interface DeleteReceipt { key: string; status: "requested" | "failed" | "missing" | "unknown"; error?: string; }
export interface DeleteOutcome { path: string; state: "deleted" | "delete-pending" | "conflict"; request?: DeleteReceipt["status"]; error?: string; }
export const DELETE_TASK_NAMESPACE = ".mineral/delete-tasks/";
interface DeleteTask { protocol: 1; mode: "direct"; identity: string; path: string; etag: string; modified: string; createdAt: string; }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function taskKey(identity: string, path: string, etag: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encode([identity, path, etag]));
  return `${DELETE_TASK_NAMESPACE}${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")}.json`;
}
function parse(bytes: Uint8Array): DeleteTask {
  if (bytes.length > 65536) throw Error("Delete task too large");
  const t = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as DeleteTask;
  if (!t || t.protocol !== 1 || t.mode !== "direct" || typeof t.identity !== "string" || typeof t.etag !== "string" || !t.etag || typeof t.path !== "string" || !Number.isFinite(Date.parse(t.modified)) || !Number.isFinite(Date.parse(t.createdAt))) throw Error("Invalid delete task");
  userPath(t.path); return t;
}
export async function ensureDeleteTombstone(port: RecoveryPort, path: string, etag: string, createdAt: string): Promise<void> {
  const key = await tombstoneKey(path, etag);
  if (!key) throw Error("Invalid tombstone identity");
  try { await port.put(key, encodeTombstone({ protocol: 1, path, deletedRemoteETag: etag, createdAt }), null, {}, "application/json"); }
  catch (error) {
    // The port identifies a conditional-create collision explicitly. A timeout or write failure
    // is never silently converted into permission to delete.
    if (!port.isPreconditionFailure?.(error)) throw error;
    const existing = await port.head(key);
    if (!existing) throw error;
    const t = parseTombstone((await port.read(key, existing.etag)).bytes);
    if (t.path !== path || t.deletedRemoteETag !== etag) throw Error("Tombstone mismatch");
  }
}
/** LIST is an absence proof only when its complete affected range was read. */
export async function checkedAbsence(port: RecoveryPort, keys: string[]): Promise<Set<string>> {
  if (port.absent) try { return await port.absent(keys); } catch { /* Exact HEAD fallback. */ }
  const absent = new Set<string>();
  for (const key of keys) try { if (!await port.head(key)) absent.add(key); } catch { /* Unknown stays pending. */ }
  return absent;
}
export async function requestDeletes(port: RecoveryPort, keys: string[]): Promise<DeleteReceipt[]> {
  if (port.removeMany) try { return await port.removeMany(keys); } catch { return keys.map(key => ({ key, status: "unknown" })); }
  return Promise.all(keys.map(async key => { try { await port.remove(key); return { key, status: "requested" as const }; } catch { return { key, status: "unknown" as const }; } }));
}
/** One immutable R2 object per intent; reloads never depend on a version manifest or local mirror. */
export class DirectDeleteStore {
  constructor(private readonly port: RecoveryPort, readonly identity: string) {}
  async deleteFiles(files: { path: string; etag: string }[], control: DeleteControl = {}): Promise<DeleteOutcome[]> {
    const results: DeleteOutcome[] = [];
    const width = control.concurrency ?? 4;
    for (let start = 0; start < files.length && control.shouldContinue?.() !== false; start += width) {
      const tasks = await Promise.all(files.slice(start, start + width).map(async file => {
        try {
          userPath(file.path);
          const source = await this.port.head(file.path, file.etag);
          if (!source || source.etag !== file.etag) { results.push({ path: file.path, state: "conflict" }); return; }
          const key = await taskKey(this.identity, file.path, file.etag);
          const task: DeleteTask = { protocol: 1, mode: "direct", identity: this.identity, path: file.path, etag: file.etag, modified: source.modified, createdAt: new Date().toISOString() };
          try { await this.port.put(key, encode(task), null, {}, "application/json"); }
          catch (error) {
            if (!this.port.isPreconditionFailure?.(error)) throw error;
            const existing = await this.port.head(key); if (!existing) throw error;
            const old = parse((await this.port.read(key, existing.etag)).bytes);
            if (old.identity !== this.identity || await taskKey(old.identity, old.path, old.etag) !== key || old.modified !== source.modified) throw Error("Delete task identity changed");
            return { key, task: old };
          }
          return { key, task };
        } catch (error) {
          let changed = false;
          try { const current = await this.port.head(file.path); changed = !!current && current.etag !== file.etag; } catch { /* Unknown. */ }
          results.push({ path: file.path, state: changed ? "conflict" : "delete-pending", error: String(error) });
        }
      }));
      results.push(...await this.finish(tasks.filter((t): t is { key: string; task: DeleteTask } => !!t), control));
    }
    return results;
  }
  private async finish(tasks: { key: string; task: DeleteTask }[], control: DeleteControl): Promise<DeleteOutcome[]> {
    const results: DeleteOutcome[] = [], ready: typeof tasks = [];
    if (!tasks.length || control.shouldContinue?.() === false) return tasks.map(({ task }) => ({ path: task.path, state: "delete-pending" }));
    // Unknown outcomes from an earlier process are reconciled before any retry.
    const absent = await checkedAbsence(this.port, tasks.map(t => t.task.path));
    await Promise.all(tasks.map(async item => {
      const { key, task: t } = item;
      if (control.shouldContinue?.() === false) { results.push({ path: t.path, state: "delete-pending" }); return; }
      try {
        await ensureDeleteTombstone(this.port, t.path, t.etag, t.createdAt);
        if (absent.has(t.path)) { await this.port.remove(key); results.push({ path: t.path, state: "deleted" }); return; }
        // This conditional read is deliberately AFTER the durable task and tombstone writes.
        const source = await this.port.head(t.path, t.etag);
        if (!source || source.etag !== t.etag || source.modified !== t.modified) { results.push({ path: t.path, state: "conflict" }); return; }
        ready.push(item);
      } catch (error) {
        let changed = false;
        try { const current = await this.port.head(t.path); changed = !!current && (current.etag !== t.etag || current.modified !== t.modified); } catch { /* Unknown. */ }
        results.push({ path: t.path, state: changed ? "conflict" : "delete-pending", error: String(error) });
      }
    }));
    if (!ready.length) return results;
    if (control.shouldContinue?.() === false) return [...results, ...ready.map(({ task }) => ({ path: task.path, state: "delete-pending" as const }))];
    const receipts = await requestDeletes(this.port, ready.map(t => t.task.path));
    const after = await checkedAbsence(this.port, ready.map(t => t.task.path));
    await Promise.all(ready.map(async ({ key, task }) => {
      const receipt = receipts.find(r => r.key === task.path);
      let state: DeleteOutcome["state"] = "delete-pending";
      if (after.has(task.path)) try { await this.port.remove(key); state = "deleted"; } catch { /* Retain the durable task if finalization is unknown. */ }
      results.push({ path: task.path, state, request: receipt?.status ?? "missing", error: receipt?.error });
    }));
    return results;
  }
  async retryPending(control: DeleteControl = {}): Promise<DeleteOutcome[]> {
    if (control.shouldContinue?.() === false) return [];
    const objects = await this.port.list(DELETE_TASK_NAMESPACE), results: DeleteOutcome[] = [];
    const width = control.concurrency ?? 4;
    for (let start = 0; start < objects.length && control.shouldContinue?.() !== false; start += width) {
      const tasks = await Promise.all(objects.slice(start, start + width).map(async object => {
        try {
          const task = parse((await this.port.read(object.key, object.etag)).bytes);
          if (task.identity !== this.identity || await taskKey(task.identity, task.path, task.etag) !== object.key) throw Error("Delete task identity mismatch");
          return { key: object.key, task };
        } catch (error) { results.push({ path: object.key, state: "delete-pending", error: String(error) }); }
      }));
      results.push(...await this.finish(tasks.filter((t): t is { key: string; task: DeleteTask } => !!t), control));
    }
    return results;
  }
}
