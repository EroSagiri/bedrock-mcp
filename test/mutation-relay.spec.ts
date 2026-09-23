import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleMutationReport, verdictStatus, type VaultMutationBinding } from "../apps/sync-gateway/src/mutations";
import { bindings, vaultIndex } from "./support";

/**
 * A writer reports an R2 change through the **Gateway**, which relays it to the Vault.
 *
 * The Gateway is the only client-facing control plane; the Vault keeps the two things that must not
 * move — verification against the authoritative object, and the journal. So the property this file
 * pins is that a relayed report still returns the *authority's* verdict: `202` recorded, `409` the
 * revision is wrong, `503` try again. A relay that invented its own answer, or that answered before
 * the authority did, would turn "do not retry this" into "retry forever".
 */

const token = "gateway-test-token";
const channel = "R".repeat(43);
const report = (body: unknown, init: RequestInit = {}) => new Request(`https://gateway.test/v1/channels/${channel}/mutations`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...init,
});

const put = (overrides: Record<string, unknown> = {}) => ({ id: "mut_report_1", op: "put", path: "notes/a.md", etag: "E1", size: 12, committedAt: 1_700_000_000_000, ...overrides });

describe("the gateway relays a report and returns the authority's verdict", () => {
  it("maps every verdict onto the status a client acts on", () => {
    expect(verdictStatus({ verdict: "accepted", seq: 1 })).toBe(202);
    expect(verdictStatus({ verdict: "duplicate", seq: 1 })).toBe(202);
    // A revision that does not describe R2 cannot be fixed by sending the report again.
    expect(verdictStatus({ verdict: "refused", reason: "state-mismatch" })).toBe(409);
    expect(verdictStatus({ verdict: "refused", reason: "invalid" })).toBe(400);
    expect(verdictStatus({ verdict: "refused", reason: "unknown-channel" })).toBe(404);
    // The journal could not commit, or the relay could not reach the authority: the report must be retried.
    expect(verdictStatus({ verdict: "refused", reason: "unavailable" })).toBe(503);
    expect(verdictStatus({ verdict: "refused", reason: "revoked" })).toBe(503);
  });

  it("passes the report through unchanged and returns the verdict unchanged", async () => {
    const seen: unknown[] = [];
    const vault: VaultMutationBinding = {
      async recordReportedMutation(request) { seen.push(request); return { verdict: "accepted", seq: 7 }; },
    };

    const response = await handleMutationReport(report(put()), channel, vault);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ verdict: "accepted", seq: 7 });
    // The relay adds nothing: not a source, not a timestamp, not a rewrite of the revision.
    expect(seen).toEqual([put()]);
  });

  it("relays a refusal instead of deciding one itself", async () => {
    const vault: VaultMutationBinding = { async recordReportedMutation() { return { verdict: "refused", reason: "state-mismatch" }; } };

    const response = await handleMutationReport(report(put()), channel, vault);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ verdict: "refused", reason: "state-mismatch" });
  });

  it("says retry, not success, when it cannot reach the authority", async () => {
    const unavailable: VaultMutationBinding = { async recordReportedMutation() { throw new Error("binding unavailable"); } };
    expect((await handleMutationReport(report(put()), channel, unavailable)).status).toBe(503);

    // No authority bound at all is the same answer: the relay never guesses that a fact was recorded.
    expect((await handleMutationReport(report(put()), channel, undefined)).status).toBe(503);

    // A verdict the relay does not understand is also not trusted as success.
    const nonsense: VaultMutationBinding = { async recordReportedMutation() { return { nonsense: true } as never; } };
    expect((await handleMutationReport(report(put()), channel, nonsense)).status).toBe(503);
  });

  it("rejects a malformed report at the edge, without waking the authority", async () => {
    let called = 0;
    const vault: VaultMutationBinding = { async recordReportedMutation() { called += 1; return { verdict: "accepted", seq: 1 }; } };

    // A put with no revision, an unknown op, an absolute path, an oversized id: none may reach a journal.
    for (const body of [put({ etag: undefined }), put({ op: "rename" }), put({ path: "/outside.md" }), put({ id: "x".repeat(129) })]) {
      expect((await handleMutationReport(report(body), channel, vault)).status).toBe(400);
    }
    expect((await handleMutationReport(report("{"), channel, vault)).status).toBe(400);
    expect((await handleMutationReport(report(put(), { headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "999999" } }), channel, vault)).status).toBe(413);
    expect(called).toBe(0);
  });

  it("authenticates before relaying, on the route itself", async () => {
    const response = await SELF.fetch(new Request(`https://gateway.test/v1/channels/${channel}/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(put()),
    }));
    expect(response.status).toBe(401);
  });
});

/**
 * The same path with the deployed pieces: `SELF` fronts the Gateway and the Vault, so the report is
 * relayed over a real binding, verified against real R2 by the real ingress, and journalled.
 */
describe("a report travels gateway → vault → journal", () => {
  const index = () => vaultIndex() as unknown as { resetMutationState(): Promise<void>; findMutation(id: string): Promise<unknown> };
  const post = (body: unknown) => SELF.fetch(report(body));

  it("records the fact the client reported and answers 202", async () => {
    await index().resetMutationState();
    const key = "relay/note.md";
    const object = (await bindings().MINERAL.put(key, new TextEncoder().encode("reported bytes")))!;

    const response = await post({ id: "mut_relay_1", op: "put", path: key, etag: object.etag, size: object.size, committedAt: Date.now() });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ verdict: "accepted" });
    await expect(index().findMutation("mut_relay_1")).resolves.toMatchObject({ id: "mut_relay_1", op: "put", path: key, source: "obsidian" });
  });

  it("refuses a report that does not describe R2, and journals nothing", async () => {
    await index().resetMutationState();
    const key = "relay/other.md";
    await bindings().MINERAL.put(key, new TextEncoder().encode("actual bytes"));

    const response = await post({ id: "mut_relay_wrong", op: "put", path: key, etag: "not-the-revision", size: 5, committedAt: Date.now() });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ verdict: "refused", reason: "state-mismatch" });
    await expect(index().findMutation("mut_relay_wrong")).resolves.toBeNull();
  });

  it("answers a retry of the same report idempotently", async () => {
    await index().resetMutationState();
    const key = "relay/retry.md";
    const object = (await bindings().MINERAL.put(key, new TextEncoder().encode("retried")))!;
    const body = { id: "mut_relay_retry", op: "put", path: key, etag: object.etag, size: object.size, committedAt: Date.now() };

    const first = await post(body);
    const second = await post(body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ verdict: "accepted" });
    // The retry is recognised, and it is still a success: the fact exists exactly once.
    await expect(second.json()).resolves.toMatchObject({ verdict: "duplicate" });
  });

  it("relays a logical deletion that names the revision it retired", async () => {
    await index().resetMutationState();
    const key = "relay/logical-delete.md";
    const object = (await bindings().MINERAL.put(key, new TextEncoder().encode("still here")))!;

    const response = await post({ id: "mut_relay_delete", op: "delete", path: key, etag: object.etag, committedAt: Date.now() });

    expect(response.status).toBe(202);
    await expect(index().findMutation("mut_relay_delete")).resolves.toMatchObject({ op: "delete", path: key });
  });
});
