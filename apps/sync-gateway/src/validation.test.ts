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

  it("accepts the mutation id and the writer identities the Vault publisher sends", async () => {
    // The publisher forwards the source of the journal fact and its idempotency key; a legitimate
    // writer must not be rejected over a diagnostic label.
    for (const source of ["obsidian", "mcp", "system", "vault", "unknown"]) {
      const request = new Request(`https://gateway.test/v1/channels/${channel}/dirty`, {
        method: "POST",
        body: JSON.stringify({ mutationId: "mut_from_vault", source, kind: "upsert", changes: [{ op: "put", path: "notes/a.md", etag: "E1", size: 3 }] }),
      });
      await expect(parseDirtyRequest(request, channel)).resolves.toMatchObject({ channel, mutationId: "mut_from_vault", source });
    }
    expect(validRpcRequest({ channel, mutationId: "mut_x", source: "mcp" })).toBe(true);
    // An unknown label is still refused, and the id stays bounded.
    expect(validRpcRequest({ channel, source: "rogue" as never })).toBe(false);
    expect(validRpcRequest({ channel, mutationId: "x".repeat(129) })).toBe(false);
  });
});
