import { describe, expect, it } from "vitest";
import { MemoryMutationStore } from "../apps/vault/src/index/memory-store";
import { journalFromStore } from "../apps/vault/src/mutation/store";
import { createMutationRecorder } from "../apps/vault/src/mutation/recorder";
import { createR2MutationVerifier, handleMutationIngressRequest, MutationIngressError } from "../apps/vault/src/mutation/http";
import { isRemoteApply, parseIngressBody, recordVerifiedMutation, type MutationVerifier } from "../apps/vault/src/mutation/ingress";
import type { MutationEvent } from "../apps/vault/src/mutation/types";
import { bindings } from "./support";

const encoder = new TextEncoder();

function fakeVerifier(objects: Record<string, { etag: string; size: number }>): MutationVerifier {
  return { async observe(path) { return objects[path] ?? null; } };
}

function harness(objects: Record<string, { etag: string; size: number }> = {}) {
  const store = new MemoryMutationStore();
  const journal = journalFromStore(store);
  const recorder = createMutationRecorder({ journal, nextId: () => "mut_generated", now: () => 1_000 });
  return { store, journal, recorder, dependencies: { recorder, journal, verifier: fakeVerifier(objects) } };
}

function putBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "mut_obsidian_1", source: "obsidian", op: "put", path: "notes/a.md", etag: "E1", size: 10, committedAt: 1_000, ...overrides });
}

describe("mutation ingress parsing", () => {
  it("accepts a bounded report from a client that wrote to R2", () => {
    expect(parseIngressBody(putBody())).toMatchObject({ id: "mut_obsidian_1", source: "obsidian", op: "put", path: "notes/a.md", etag: "E1" });
  });

  it("rejects a malformed body, an unknown source, and an MCP forgery", () => {
    expect(parseIngressBody("not json")).toBeNull();
    expect(parseIngressBody(JSON.stringify({ ...JSON.parse(putBody()), source: "rogue" }))).toBeNull();
    // MCP writes are recorded by the Vault itself; a client may not claim to be MCP.
    expect(parseIngressBody(putBody({ source: "mcp" }))).toBeNull();
    expect(parseIngressBody(putBody({ op: "put", etag: undefined }))).toBeNull();
    expect(parseIngressBody(putBody({ committedAt: undefined }))).toBeNull();
    expect(parseIngressBody(putBody({ path: "/absolute.md" }))).toBeNull();
  });

  it("treats a remote apply as no fact at all", () => {
    expect(isRemoteApply({ origin: "remote-apply" })).toBe(true);
    expect(isRemoteApply({ origin: "local-write" })).toBe(false);
    expect(isRemoteApply({ origin: "unknown" })).toBe(false);
  });
});

describe("mutation ingress verification", () => {
  it("accepts a put whose reported ETag matches R2", async () => {
    const { store, dependencies } = harness({ "notes/a.md": { etag: "E1", size: 10 } });
    const outcome = await recordVerifiedMutation(dependencies, parseIngressBody(putBody())!);

    expect(outcome.status).toBe("accepted");
    expect(store.snapshotJournal()).toHaveLength(1);
    expect(store.snapshotJournal()[0]).toMatchObject({ source: "obsidian", op: "put", etag: "E1" });
  });

  it("rejects a put whose reported ETag is not what R2 holds", async () => {
    const { store, dependencies } = harness({ "notes/a.md": { etag: "ACTUAL", size: 10 } });
    const outcome = await recordVerifiedMutation(dependencies, parseIngressBody(putBody())!);

    expect(outcome).toMatchObject({ status: "rejected", reason: "state-mismatch" });
    expect(store.snapshotJournal()).toHaveLength(0);
    expect(store.snapshotIntents()).toHaveLength(0);
  });

  it("rejects a put for an object that does not exist and a delete for one that does", async () => {
    const missing = harness();
    expect(await recordVerifiedMutation(missing.dependencies, parseIngressBody(putBody())!)).toMatchObject({ status: "rejected" });

    const present = harness({ "notes/a.md": { etag: "E1", size: 10 } });
    const deleteBody = JSON.stringify({ id: "mut_obsidian_del", source: "obsidian", op: "delete", path: "notes/a.md", committedAt: 1_000 });
    expect(await recordVerifiedMutation(present.dependencies, parseIngressBody(deleteBody)!)).toMatchObject({ status: "rejected" });
  });

  it("accepts a delete whose object is already gone", async () => {
    const { store, dependencies } = harness();
    const deleteBody = JSON.stringify({ id: "mut_obsidian_del", source: "obsidian", op: "delete", path: "notes/a.md", committedAt: 1_000 });
    const outcome = await recordVerifiedMutation(dependencies, parseIngressBody(deleteBody)!);

    expect(outcome.status).toBe("accepted");
    expect(store.snapshotJournal()[0]).toMatchObject({ op: "delete", path: "notes/a.md" });
  });

  it("answers a retry of the same mutation id idempotently, even after R2 moved on", async () => {
    const objects = { "notes/a.md": { etag: "E1", size: 10 } };
    const { store, dependencies } = harness(objects);
    const event = parseIngressBody(putBody())!;

    await recordVerifiedMutation(dependencies, event);
    // The next write lands: a strict re-verification would now reject, which would make the retry
    // unanswerable forever. Idempotency is checked first, so the retry still succeeds.
    objects["notes/a.md"] = { etag: "E2", size: 11 };
    const retry = await recordVerifiedMutation(dependencies, event);

    expect(retry.status).toBe("duplicate");
    expect(store.snapshotJournal()).toHaveLength(1);
  });

  it("verifies the reported revision against the real R2 ETag, quotes or not", async () => {
    const verifier = createR2MutationVerifier(bindings().MINERAL);
    const key = "ingress-verification/note.md";
    const put = (await bindings().MINERAL.put(key, encoder.encode("hello")))!;
    const observed = await verifier.observe(key);

    expect(observed?.size).toBe(5);
    expect(observed?.etag).toBe(put.etag.replace(/"/g, ""));

    const { journal, recorder, store } = harness();
    const reported = `"${put.etag.replace(/"/g, "")}"`;
    const event: MutationEvent = { id: "mut_r2_check", source: "obsidian", op: "put", path: key, etag: reported, size: 5, committedAt: 1_000 };
    const accepted = { recorder, journal, verifier };
    expect((await recordVerifiedMutation(accepted, event)).status).toBe("accepted");
    expect((await recordVerifiedMutation(accepted, { ...event, id: "mut_r2_wrong", etag: "different" })).status).toBe("rejected");
    expect(store.snapshotJournal()).toHaveLength(1);
  });
});

describe("POST /internal/mutations", () => {
  const post = (body: string, headers: Record<string, string> = {}) => new Request("https://vault.internal/internal/mutations", {
    method: "POST",
    body,
    headers: { authorization: "Bearer ingress-test-token", "content-type": "application/json", ...headers },
  });

  it("rejects an unauthenticated or unconfigured ingress", async () => {
    const ingressEnv = { MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "ingress-test-token" };
    const { service } = ingressFor();
    expect((await handleMutationIngressRequest(post(putBody(), { authorization: "Bearer wrong" }), ingressEnv, service)).status).toBe(401);
    expect((await handleMutationIngressRequest(post(putBody()), { MINERAL: bindings().MINERAL }, service)).status).toBe(503);
  });

  function ingressFor(objects: Record<string, { etag: string; size: number }> = {}) {
    const { dependencies, recorder, store } = harness(objects);
    return {
      store,
      service: {
        async record(event: MutationEvent) {
          const outcome = await recordVerifiedMutation({ ...dependencies, recorder }, event);
          if (outcome.status === "rejected") throw new MutationIngressError("state-mismatch");
          return { status: outcome.status, seq: outcome.record.seq };
        },
      },
    };
  }

  it("answers 202 for an accepted report and 409 for a mismatched revision", async () => {
    const ingressEnv = { MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "ingress-test-token" };
    const accepted = ingressFor({ "notes/a.md": { etag: "E1", size: 10 } });
    const ok = await handleMutationIngressRequest(post(putBody()), ingressEnv, accepted.service);
    expect(ok.status).toBe(202);
    await expect(ok.json()).resolves.toMatchObject({ status: "accepted", seq: 1, mutationId: "mut_obsidian_1" });

    const mismatched = ingressFor({ "notes/a.md": { etag: "OTHER", size: 10 } });
    expect((await handleMutationIngressRequest(post(putBody()), ingressEnv, mismatched.service)).status).toBe(409);

    const invalid = ingressFor();
    expect((await handleMutationIngressRequest(post("{"), ingressEnv, invalid.service)).status).toBe(400);
    expect((await handleMutationIngressRequest(post(putBody(), { "content-length": "999999" }), ingressEnv, invalid.service)).status).toBe(413);
  });

  it("answers 204 for a remote apply instead of recording a fact", async () => {
    const ingressEnv = { MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "ingress-test-token" };
    const { service, store } = ingressFor({ "notes/a.md": { etag: "E1", size: 10 } });
    const response = await handleMutationIngressRequest(post(putBody(), { "x-mineral-mutation-origin": "remote-apply" }), ingressEnv, service);
    expect(response.status).toBe(204);
    expect(store.snapshotJournal()).toHaveLength(0);
  });

  it("answers 503 when the journal cannot commit, so the client retries", async () => {
    const ingressEnv = { MINERAL: bindings().MINERAL, MUTATION_INGRESS_TOKEN: "ingress-test-token" };
    const failing = {
      async record(_event: MutationEvent): Promise<{ status: "accepted"; seq: number }> {
        throw new Error("journal unavailable");
      },
    };
    const response = await handleMutationIngressRequest(post(putBody()), ingressEnv, failing);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "journal_unavailable" });
  });
});
