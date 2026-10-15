import { describe, expect, it } from "vitest";
import { DirectDeleteStore, RecoveryStore, DELETE_TASK_NAMESPACE, type DeleteReceipt } from "@mineral/sync-core/recovery";
import { tombstoneKey, encodeTombstone } from "@mineral/sync-core/tombstones";
import { RecoveryMemory } from "./recovery-memory";

class Port extends RecoveryMemory {
  isPreconditionFailure(error: unknown) { return String(error).includes("conditional PUT failed"); }
  batches: string[][] = [];
  mode = "ok";
  async removeMany(keys: string[]): Promise<DeleteReceipt[]> {
    this.batches.push(keys);
    const output: DeleteReceipt[] = [];
    for (const key of keys) {
      if (this.mode === "partial" && key.endsWith("1.md")) { output.push({ key, status: "failed", error: "AccessDenied" }); continue; }
      if (this.mode === "still-present") { output.push({ key, status: "requested" }); continue; }
      if (this.mode === "missing" && key.endsWith("1.md")) continue;
      await super.remove(key); output.push({ key, status: "requested" });
    }
    if (this.mode === "unknown") throw Error("lost response");
    return output;
  }
  async absent(keys: string[]) { return new Set(keys.filter(k => !this.objects.has(k))); }
}
async function setup(count = 4) {
  const port = new Port();
  const files = [];
  for (let i = 0; i < count; i++) { const o = await port.put(`folder/${i}.md`, new TextEncoder().encode(`test ${i}`), null); files.push({ path: o.key, etag: o.etag }); }
  return { port, files, store: new DirectDeleteStore(port, "identity") };
}
describe("durable direct deletion", () => {
  it("creates no version body or manifest, preserves historical versions, and hides unrestorable tombstones", async () => {
    const { port, files, store } = await setup();
    const recovery = new RecoveryStore(port, "identity"); await recovery.backup(files[0].path, files[0].etag);
    const historical = await port.list(".mineral/versions/"); port.calls.length = 0;
    expect((await store.deleteFiles(files)).every(r => r.state === "deleted")).toBe(true);
    expect(port.calls.some(c => c.startsWith("PUT .mineral/versions/"))).toBe(false);
    expect(await port.list(".mineral/versions/")).toEqual(historical);
    expect(await port.list(DELETE_TASK_NAMESPACE)).toEqual([]);
    expect((await recovery.list()).filter(e => e.kind === "tombstone").every(e => !e.recoverable)).toBe(true);
    expect(port.batches).toHaveLength(1);
  });
  it("conditionally creates tombstones without a preceding HEAD", async () => {
    const { port, files, store } = await setup(1); await store.deleteFiles(files);
    expect(port.calls.filter(c => c.includes("/tombstones/")).map(c => c.split(" ")[0])).toEqual(["PUT"]);
  });
  it("accepts only an existing matching tombstone", async () => {
    const { port, files, store } = await setup(1);
    const key = (await tombstoneKey(files[0].path, files[0].etag))!;
    await port.put(key, encodeTombstone({ protocol: 1, path: files[0].path, deletedRemoteETag: files[0].etag, createdAt: new Date().toISOString() }), null);
    expect((await store.deleteFiles(files))[0].state).toBe("deleted");
    expect(port.calls).toContain(`GET ${key}`);
  });
  for (const kind of ["corrupt", "mismatch", "write-failure"]) it(`does not DELETE with a ${kind} tombstone`, async () => {
    const { port, files, store } = await setup(1);
    const key = (await tombstoneKey(files[0].path, files[0].etag))!;
    if (kind === "write-failure") port.failPut = "/tombstones/";
    else await port.put(key, kind === "corrupt" ? new TextEncoder().encode("bad") : encodeTombstone({ protocol: 1, path: "other.md", deletedRemoteETag: files[0].etag, createdAt: new Date().toISOString() }), null);
    expect((await store.deleteFiles(files))[0].state).toBe("delete-pending");
    expect(port.batches).toHaveLength(0); expect(await port.head(files[0].path)).not.toBeNull();
  });
  for (const mode of ["partial", "missing", "still-present"]) it(`retains per-item pending tasks for ${mode} results, then resumes after reload`, async () => {
    const { port, files, store } = await setup(); port.mode = mode;
    const results = await store.deleteFiles(files);
    expect(results.some(r => r.state === "delete-pending")).toBe(true);
    expect(results.find(r => r.path.endsWith("1.md"))?.request).toBe(mode === "partial" ? "failed" : mode === "missing" ? "missing" : "requested");
    port.mode = "ok";
    expect((await new DirectDeleteStore(port, "identity").retryPending()).every(r => r.state === "deleted")).toBe(true);
    expect(await port.list(DELETE_TASK_NAMESPACE)).toEqual([]);
  });
  it("verifies absence even if every DELETE response was lost", async () => {
    const { port, files, store } = await setup(); port.mode = "unknown";
    const results = await store.deleteFiles(files);
    expect(results.every(r => r.state === "deleted" && r.request === "unknown")).toBe(true);
  });
  it("retains tasks when post-DELETE verification is unavailable, and verifies before replay", async () => {
    const { port, files, store } = await setup(1);
    let deleted = false; const remove = port.removeMany.bind(port), head = port.head.bind(port);
    port.removeMany = async keys => { const r = await remove(keys); deleted = true; return r; };
    port.absent = async () => { if (deleted) throw Error("offline"); return new Set(); };
    port.head = async (...args) => { if (deleted) throw Error("offline"); return head(...args); };
    expect((await store.deleteFiles(files))[0].state).toBe("delete-pending");
    port.head = head; port.absent = async keys => new Set(keys.filter(k => !port.objects.has(k)));
    expect((await new DirectDeleteStore(port, "identity").retryPending())[0].state).toBe("deleted");
    expect(port.batches).toHaveLength(1);
  });
  it("rejects changed ETags before initial deletion", async () => {
    const { port, files, store } = await setup(1); await port.put(files[0].path, new TextEncoder().encode("new"), files[0].etag);
    expect((await store.deleteFiles(files))[0].state).toBe("conflict"); expect(port.batches).toHaveLength(0);
  });
  it("revalidates the source after the tombstone write and refuses a changed source", async () => {
    const { port, files, store } = await setup(1); const put = port.put.bind(port);
    port.put = async (...args) => {
      const result = await put(...args);
      if (args[0].includes('/tombstones/')) await put(files[0].path, new TextEncoder().encode('recreated'), files[0].etag);
      return result;
    };
    expect((await store.deleteFiles(files))[0].state).toBe('conflict'); expect(port.batches).toHaveLength(0);
  });
  it("cannot delete when the durable task write fails", async () => {
    const { port, files, store } = await setup(1); port.failPut = DELETE_TASK_NAMESPACE;
    expect((await store.deleteFiles(files))[0].state).toBe('delete-pending');
    expect(port.batches).toHaveLength(0); expect(await port.list('.mineral/tombstones/')).toEqual([]);
  });
  it("does not replay a pending DELETE against a recreated name", async () => {
    const { port, files, store } = await setup(1); port.mode = "still-present"; await store.deleteFiles(files);
    const newer = await port.put(files[0].path, new TextEncoder().encode("new"), files[0].etag); port.mode = "ok";
    expect((await new DirectDeleteStore(port, "identity").retryPending())[0].state).toBe("conflict");
    expect(port.batches).toHaveLength(1); expect((await port.head(newer.key))?.etag).toBe(newer.etag);
  });
  it("also fences a recreated same-ETag object with a changed modification time", async () => {
    const { port, files, store } = await setup(1); port.mode = "still-present"; await store.deleteFiles(files);
    port.objects.get(files[0].path)!.object.modified = "2026-10-15T12:00:00.000Z";
    expect((await store.retryPending())[0].state).toBe("conflict"); expect(port.batches).toHaveLength(1);
  });
  it("does not trust malformed or identity-mismatched durable tasks", async () => {
    const { port, files, store } = await setup(1); port.mode = "still-present"; await store.deleteFiles(files);
    expect((await new DirectDeleteStore(port, "other-identity").retryPending())[0].error).toContain("identity mismatch");
    const task = (await port.list(DELETE_TASK_NAMESPACE))[0]; await port.put(task.key, new TextEncoder().encode("bad"), task.etag);
    expect((await store.retryPending())[0].state).toBe("delete-pending"); expect(port.batches).toHaveLength(1);
  });
  it("Android pauses between batches and before the DELETE, including pending retries", async () => {
    const { port, files, store } = await setup(3); let running = true;
    const remove = port.removeMany.bind(port); port.removeMany = async keys => { const r = await remove(keys); running = false; return r; };
    const control = { concurrency: 1 as const, shouldContinue: () => running };
    expect(await store.deleteFiles(files, control)).toHaveLength(1); expect(port.batches).toHaveLength(1);
    running = true; port.mode = "still-present"; await store.deleteFiles(files.slice(1));
    const before = port.batches.length; running = true;
    await store.retryPending(control); expect(port.batches.length).toBe(before + 1);
    running = false; expect(await store.retryPending(control)).toEqual([]);
  });
  it("switching the configured mode cannot turn an old backed-up task into a direct task", async () => {
    const { port, files } = await setup(1); const recovery = new RecoveryStore(port, "identity"); port.failDelete = true;
    await recovery.deleteFile(files[0].path, files[0].etag, true); port.failDelete = false;
    expect(await new DirectDeleteStore(port, "identity").retryPending()).toEqual([]);
    expect(await recovery.retryPending({ concurrency: 1 })).toBe(1);
    expect((await recovery.list()).some(e => e.kind === "version" && e.state === "deleted")).toBe(true);
  });
  it("backed-up retries stop discovery at Android's one-item boundary", async () => {
    const { port, files } = await setup(3); const recovery = new RecoveryStore(port, 'identity');
    port.failDelete = true; for (const file of files) await recovery.deleteFile(file.path, file.etag, true);
    port.failDelete = false; port.calls.length = 0;
    let running = true, reads = 0; const read = port.read.bind(port);
    port.read = async (...args) => { const value = await read(...args); if (args[0].endsWith('manifest.toml')) { reads++; running = false; } return value; };
    expect(await recovery.retryPending({ concurrency: 1, shouldContinue: () => running })).toBe(0);
    expect(reads).toBe(1); expect(port.calls.some(c => c.startsWith('DELETE '))).toBe(false);
  });
  it("backup batches retain complete versions", async () => {
    const { port, files } = await setup(); const recovery = new RecoveryStore(port, "identity");
    expect((await recovery.deleteFiles(files)).every(r => r.state === "deleted")).toBe(true);
    expect((await recovery.list()).filter(e => e.kind === "version" && e.state === "deleted")).toHaveLength(4);
    expect(port.batches).toHaveLength(1);
  });
});
