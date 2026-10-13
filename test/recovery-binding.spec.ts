import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { RecoveryStore, parseManifest, recoverySelection } from "@mineral/sync-core/recovery";
import { r2RecoveryPort } from "../apps/vault/src/recovery-port";
import { bindings } from "./support";
describe("workerd R2 recovery and optional gateway notification", () => {
  it("uses the R2 binding for TOML versions, real absence, restore and grouped cleanup", async () => {
    const bucket = bindings().MINERAL; const port = r2RecoveryPort(bucket);
    const key = `binding-${crypto.randomUUID()}.md`;
    const source = await port.put(key, new TextEncoder().encode("before deletion"), null);
    const store = new RecoveryStore(port, "test");
    const result = await store.deleteFile(key, source.etag, true);
    expect(result.state).toBe("deleted"); expect(await bucket.head(key)).toBeNull();
    const entry = (await store.list()).find(e => e.path === key && e.kind === "version")!;
    expect(parseManifest(new Uint8Array(await (await bucket.get(entry.key))!.arrayBuffer())).state).toBe("deleted");
    await store.execute({ identity: "test", confirmed: true, action: "restore", selection: recoverySelection(entry), target: key, expectedTargetETag: null });
    expect(await (await bucket.get(key))!.text()).toBe("before deletion");
    await store.execute({ identity: "test", confirmed: true, action: "clean", selections: (await store.list()).filter(e => e.path === key).map(recoverySelection) });
    expect((await store.list()).some(e => e.path === key)).toBe(false);
    expect(await bucket.head(key)).not.toBeNull();
    await bucket.delete(key);
  });
  it("publishes a recovery change through generation without making the gateway a data execution requirement", async () => {
    const channel = "R".repeat(43); const headers = { Authorization: "Bearer gateway-test-token" };
    const get = async () => (await (await SELF.fetch(`https://gateway.test/v1/channels/${channel}`, { headers })).json() as { generation: string }).generation;
    const before = await get();
    const response = await SELF.fetch(`https://gateway.test/v1/channels/${channel}/dirty`, { method: "POST", headers, body: JSON.stringify({ source: "obsidian", kind: "unknown", mutationId: `recovery-${crypto.randomUUID()}` }) });
    expect(response.status).toBe(200); await response.arrayBuffer(); expect(BigInt(await get())).toBe(BigInt(before) + 1n);
    const health = await SELF.fetch("https://gateway.test/health"); expect(await health.json()).toMatchObject({ version: "0.0.3", recoverySource: "direct-r2" });
  });
});
