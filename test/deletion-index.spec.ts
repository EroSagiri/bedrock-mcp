import { describe, expect, it } from "vitest";
import { handleDeletionIndex } from "../apps/sync-gateway/src/deletions";

const channel = "A".repeat(43);

describe("Gateway deletion index relay", () => {
  it("auth-scoped routing can relay a validated page without reading R2", async () => {
    const response = await handleDeletionIndex(
      new Request(`https://gateway.test/v1/channels/${channel}/deletions?limit=1`),
      channel,
      { listSyncDeletions: async input => ({ protocol: 1, snapshotSeq: "9", entries: [{ path: "gone.md", deletedRemoteETag: "E", committedAt: 1, mutationSeq: 9 }], nextCursor: input.limit === 1 ? "gone.md" : undefined }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ snapshotSeq: "9", nextCursor: "gone.md" });
  });

  it("rejects an invalid snapshot before calling the Vault", async () => {
    let called = false;
    const response = await handleDeletionIndex(
      new Request(`https://gateway.test/v1/channels/${channel}/deletions?snapshot=-1`),
      channel,
      { listSyncDeletions: async () => { called = true; return null; } },
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
