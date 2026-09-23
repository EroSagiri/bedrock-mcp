import { describe, expect, it } from "vitest";
import { parseDirtyRequest, validRpcRequest } from "./validation";

const channel = "a".repeat(43);

describe("gateway change validation", () => {
  it("accepts bounded path-scoped changes without widening the request surface", async () => {
    const request = new Request(`https://gateway.test/v1/channels/${channel}/dirty`, {
      method: "POST",
      body: JSON.stringify({ source: "obsidian", kind: "upsert", changes: [{ op: "put", path: "notes/one.md", etag: "e1", size: 3, modified: "2026-09-22T00:00:00.000Z" }, { op: "delete", path: "notes/old.md" }] }),
    });
    await expect(parseDirtyRequest(request, channel)).resolves.toMatchObject({ channel, changes: [{ op: "put", path: "notes/one.md" }, { op: "delete", path: "notes/old.md" }] });
  });

  it("rejects absolute or oversized change paths", async () => {
    const request = new Request(`https://gateway.test/v1/channels/${channel}/dirty`, { method: "POST", body: JSON.stringify({ changes: [{ op: "put", path: "/outside.md" }] }) });
    await expect(parseDirtyRequest(request, channel)).resolves.toBeNull();
    expect(validRpcRequest({ channel, changes: [{ op: "delete", path: "x".repeat(4097) }] })).toBe(false);
  });
});
