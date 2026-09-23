import { describe, expect, it } from "vitest";
import { vaultEntrypoint } from "./support";

/**
 * Whether the deployed storage engine speaks FTS5.
 *
 * The full-text plan rests on it, and the answer has to come from the runtime that will run it. The
 * local test pool is miniflare; `probeStorage()` asks whichever Durable Object it is pointed at, so
 * the same call answers for production through the deployed entrypoint.
 */
describe("VaultIndex storage capabilities", () => {
  it("creates, matches and drops an FTS5 table", async () => {
    const result = await (vaultEntrypoint() as unknown as { probeStorage(): Promise<Record<string, unknown>> }).probeStorage();

    expect(result.fts5).toBe(true);
    expect(result.matched).toBe(1);
    // The probe leaves nothing behind: it is a question, not a schema change.
    expect(result.cleanedUp).toBe(true);
  });
});
