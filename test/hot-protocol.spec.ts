import { describe, expect, it } from "vitest";
import {
  HOT_PROTOCOL_VERSION,
  MAX_HOT_UPDATE_BYTES,
  conflictIdentity,
  createHotSessionTicket,
  decodeHotPayload,
  encodeHotPayload,
  hotContentHash,
  isHotAcquireRequest,
  isHotReleaseRequest,
  isHotRemoteObservation,
  isHotServerFrame,
  isPathBinding,
  parseHotClientMessage,
  verifyHotSessionTicket,
} from "@mineral/sync-core/hot-protocol";
import { isNamespaceIntent, isNamespaceResult } from "@mineral/sync-core/namespace-protocol";
import { canonicalVaultPath, isCanonicalVaultPath } from "@mineral/sync-core/paths";
import { TOMBSTONE_NAMESPACE, encodeTombstone, isInternalRemoteKey, parseTombstone, tombstoneKey, validateTombstone } from "@mineral/sync-core/tombstones";

const DOCUMENT = "AbCdEfGhIjKlMnOpQrStUv";
const CLIENT = "client-a";

function updateOf(text: string): string {
  return encodeHotPayload(new TextEncoder().encode(text));
}

describe("canonical paths", () => {
  it("normalizes separators and rejects anything that is not addressable", () => {
    expect(canonicalVaultPath("notes\\a.md")).toBe("notes/a.md");
    expect(canonicalVaultPath("/notes/a.md")).toBe("notes/a.md");
    expect(canonicalVaultPath("notes/./a.md")).toBeUndefined();
    expect(canonicalVaultPath("notes//a.md")).toBeUndefined();
    expect(canonicalVaultPath("notes/../a.md")).toBeUndefined();
    expect(canonicalVaultPath("notes/")).toBeUndefined();
    expect(canonicalVaultPath("")).toBeUndefined();
    expect(canonicalVaultPath("a\u0000b")).toBeUndefined();
    expect(canonicalVaultPath(42)).toBeUndefined();
  });

  it("distinguishes already-canonical values from near misses", () => {
    expect(isCanonicalVaultPath("notes/a.md")).toBe(true);
    expect(isCanonicalVaultPath("/notes/a.md")).toBe(false);
    expect(isCanonicalVaultPath("notes\\a.md")).toBe(false);
  });
});

describe("tombstones", () => {
  it("derives one key per (path, revision) and refuses non-canonical input", async () => {
    const first = await tombstoneKey("a.md", "etag-1");
    const again = await tombstoneKey("a.md", "etag-1");
    const otherRevision = await tombstoneKey("a.md", "etag-2");
    expect(first).toBe(again);
    expect(first).not.toBe(otherRevision);
    expect(first!.startsWith(TOMBSTONE_NAMESPACE)).toBe(true);
    expect(isInternalRemoteKey(first!)).toBe(true);
    expect(await tombstoneKey("/a.md", "etag-1")).toBeUndefined();
    expect(await tombstoneKey("a.md", "")).toBeUndefined();
  });

  it("round-trips a record and fails closed on malformed input", () => {
    const record = { protocol: 1 as const, path: "a.md", deletedRemoteETag: "etag-1", createdAt: new Date(0).toISOString() };
    expect(parseTombstone(encodeTombstone(record))).toEqual(record);
    expect(() => parseTombstone("{")).toThrow();
    expect(() => validateTombstone({ ...record, path: "/a.md" })).toThrow();
    expect(() => validateTombstone({ ...record, deletedRemoteETag: "" })).toThrow();
  });
});

describe("hot client frames", () => {
  const base = { protocol: HOT_PROTOCOL_VERSION, documentId: DOCUMENT, epoch: 3, clientId: CLIENT, clientOperationId: "op-1" };

  it("accepts a well-formed operation", () => {
    const frame = parseHotClientMessage({ ...base, type: "operation", update: updateOf("hello"), parentRevision: 7 });
    expect(frame).toEqual({ ...base, type: "operation", update: updateOf("hello"), parentRevision: 7 });
  });

  it("refuses an update that is empty, oversized, or not base64url", () => {
    expect(parseHotClientMessage({ ...base, type: "operation", update: "", parentRevision: 0 })).toBeUndefined();
    expect(parseHotClientMessage({ ...base, type: "operation", update: "not base64!", parentRevision: 0 })).toBeUndefined();
    const oversized = encodeHotPayload(new Uint8Array(MAX_HOT_UPDATE_BYTES + 1));
    expect(parseHotClientMessage({ ...base, type: "operation", update: oversized, parentRevision: 0 })).toBeUndefined();
  });

  it("refuses a frame whose epoch is not a positive integer", () => {
    expect(parseHotClientMessage({ ...base, type: "operation", epoch: 0, update: updateOf("x"), parentRevision: 0 })).toBeUndefined();
    expect(parseHotClientMessage({ ...base, type: "operation", epoch: 1.5, update: updateOf("x"), parentRevision: 0 })).toBeUndefined();
  });

  it("parses keepalives without identity and checkpoint requests with a target", () => {
    expect(parseHotClientMessage({ protocol: HOT_PROTOCOL_VERSION, type: "ping" })).toEqual({ protocol: HOT_PROTOCOL_VERSION, type: "ping" });
    const request = { ...base, type: "checkpoint-request", upToRevision: 12 };
    expect(parseHotClientMessage(request)).toEqual(request);
    expect(parseHotClientMessage({ ...base, type: "checkpoint-request" })).toBeUndefined();
  });

  it("parses a leave that asks for a checkpoint", () => {
    const leave = { ...base, type: "leave", checkpoint: true };
    expect(parseHotClientMessage(leave)).toEqual(leave);
    expect(parseHotClientMessage({ ...base, type: "leave" })).toBeUndefined();
  });
});

describe("hot server frames", () => {
  it("requires a receipt to name an exact revision and hash", () => {
    const receipt = {
      protocol: HOT_PROTOCOL_VERSION,
      type: "checkpoint",
      documentId: DOCUMENT,
      epoch: 2,
      canonicalPath: "a.md",
      documentRevision: 42,
      contentHash: "a".repeat(64),
      r2ETag: "etag-42",
      commitId: "commit-42",
      latestAcceptedRevision: 45,
      latestCheckpointedRevision: 42,
      checkpointedAt: 1,
    };
    expect(isHotServerFrame(receipt)).toBe(true);
    // The whole point of the receipt: it may never claim the later revision was saved.
    expect(receipt.latestCheckpointedRevision).toBe(42);
    expect(receipt.latestAcceptedRevision).toBe(45);
    expect(isHotServerFrame({ ...receipt, contentHash: "short" })).toBe(false);
    expect(isHotServerFrame({ ...receipt, documentRevision: undefined })).toBe(false);
  });

  it("accepts a welcome only when it carries a decodable CRDT state", () => {
    const welcome = {
      protocol: HOT_PROTOCOL_VERSION,
      type: "welcome",
      documentId: DOCUMENT,
      epoch: 1,
      canonicalPath: "a.md",
      state: "active",
      serverRevision: 3,
      latestCheckpointedRevision: 1,
      crdtState: encodeHotPayload(new Uint8Array([1, 2, 3])),
      pendingSave: false,
    };
    expect(isHotServerFrame(welcome)).toBe(true);
    expect(isHotServerFrame({ ...welcome, crdtState: "!!" })).toBe(false);
    expect(isHotServerFrame({ ...welcome, state: "renamed" })).toBe(false);
  });
});

describe("bindings and observations", () => {
  it("keeps a path with no document at epoch zero", () => {
    expect(isPathBinding({ canonicalPath: "a.md", documentId: null, epoch: 0, state: "deleted", updatedAt: 1 })).toBe(true);
    expect(isPathBinding({ canonicalPath: "a.md", documentId: null, epoch: 3, state: "deleted", updatedAt: 1 })).toBe(false);
    expect(isPathBinding({ canonicalPath: "a.md", documentId: DOCUMENT, epoch: 3, state: "active", updatedAt: 1 })).toBe(true);
    expect(isPathBinding({ canonicalPath: "/a.md", documentId: DOCUMENT, epoch: 3, state: "active", updatedAt: 1 })).toBe(false);
  });

  it("distinguishes an object that a tombstone retired from a newer one", () => {
    const deleted = { canonicalPath: "a.md", exists: false, etag: "etag-1", size: 3, deleted: true, tombstoneTargets: "etag-1", contentHash: null };
    expect(isHotRemoteObservation(deleted)).toBe(true);
    const recreated = { ...deleted, exists: true, etag: "etag-2", deleted: false, tombstoneTargets: "etag-1" };
    expect(isHotRemoteObservation(recreated)).toBe(true);
    expect(isHotRemoteObservation({ ...deleted, exists: "no" })).toBe(false);
  });
});

describe("session tickets", () => {
  const secret = "gateway-secret";

  it("binds the ticket to channel, document, epoch, and client", async () => {
    const ticket = await createHotSessionTicket({ channel: "A".repeat(43), documentId: DOCUMENT, epoch: 3, clientId: CLIENT, secret, ttlMs: 60_000, now: 1_000 });
    const verified = await verifyHotSessionTicket({ ticket: ticket.ticket, channel: "A".repeat(43), secret, now: 2_000 });
    expect(verified).toEqual({ documentId: DOCUMENT, epoch: 3, clientId: CLIENT });
    expect(await verifyHotSessionTicket({ ticket: ticket.ticket, channel: "B".repeat(43), secret, now: 2_000 })).toBeUndefined();
    expect(await verifyHotSessionTicket({ ticket: ticket.ticket, channel: "A".repeat(43), secret: "other", now: 2_000 })).toBeUndefined();
  });

  it("expires and refuses tampering", async () => {
    const ticket = await createHotSessionTicket({ channel: "A".repeat(43), documentId: DOCUMENT, epoch: 1, clientId: CLIENT, secret, ttlMs: 1_000, now: 1_000 });
    expect(await verifyHotSessionTicket({ ticket: ticket.ticket, channel: "A".repeat(43), secret, now: 2_001 })).toBeUndefined();
    const parts = ticket.ticket.split(".");
    parts[3] = "9";
    expect(await verifyHotSessionTicket({ ticket: parts.join("."), channel: "A".repeat(43), secret, now: 1_500 })).toBeUndefined();
    expect(await verifyHotSessionTicket({ ticket: undefined, channel: "A".repeat(43), secret, now: 1_500 })).toBeUndefined();
  });

  it("never carries the signing secret", async () => {
    const ticket = await createHotSessionTicket({ channel: "A".repeat(43), documentId: DOCUMENT, epoch: 1, clientId: CLIENT, secret, ttlMs: 1_000, now: 0 });
    expect(ticket.ticket).not.toContain(secret);
  });
});

describe("acquisition requests", () => {
  it("accepts only bounded, canonical requests", () => {
    const request = {
      protocol: HOT_PROTOCOL_VERSION,
      operationId: "acquire-1",
      canonicalPath: "notes/a.md",
      clientId: CLIENT,
      expected: { state: "unknown" },
      local: { contentHash: "b".repeat(64), size: 12 },
      wantSession: true,
    };
    expect(isHotAcquireRequest(request)).toBe(true);
    expect(isHotAcquireRequest({ ...request, canonicalPath: "/notes/a.md" })).toBe(false);
    expect(isHotAcquireRequest({ ...request, local: { contentHash: "b".repeat(64), size: "12" } })).toBe(false);
    expect(isHotAcquireRequest({ ...request, expected: { state: "bound", documentId: DOCUMENT, epoch: 0 } })).toBe(false);
  });

  it("accepts a release that names the revision it needs covered", () => {
    const release = { protocol: HOT_PROTOCOL_VERSION, operationId: "release-1", clientId: CLIENT, documentId: DOCUMENT, epoch: 4, checkpoint: true, lastAcceptedRevision: 9 };
    expect(isHotReleaseRequest(release)).toBe(true);
    expect(isHotReleaseRequest({ ...release, lastAcceptedRevision: -1 })).toBe(false);
  });
});

describe("namespace intents", () => {
  it("accepts the three lifecycle operations and refuses near misses", () => {
    const create = { protocol: 1, type: "create", operationId: "ns-1", clientId: CLIENT, canonicalPath: "notes/a.md", expectedPathState: { state: "absent" }, local: null };
    const del = { protocol: 1, type: "delete", operationId: "ns-2", clientId: CLIENT, canonicalPath: "notes/a.md", documentId: DOCUMENT, expectedEpoch: 2, expectedRemoteETag: "etag-1", expectedDocumentRevision: 5 };
    const rename = { protocol: 1, type: "rename", operationId: "ns-3", clientId: CLIENT, fromPath: "notes/a.md", toPath: "archive/a.md", documentId: DOCUMENT, expectedEpoch: 2, expectedFromBinding: { documentId: DOCUMENT, epoch: 2 }, expectedToPathState: { state: "absent" } };
    expect(isNamespaceIntent(create)).toBe(true);
    expect(isNamespaceIntent(del)).toBe(true);
    expect(isNamespaceIntent(rename)).toBe(true);
    expect(isNamespaceIntent({ ...rename, toPath: "notes/a.md" })).toBe(false);
    expect(isNamespaceIntent({ ...del, expectedEpoch: 0 })).toBe(false);
    expect(isNamespaceIntent({ ...create, expectedPathState: { state: "bound", documentId: DOCUMENT, epoch: 1 } })).toBe(false);
  });

  it("accepts a result that reports a conflict without a binding", () => {
    const result = { protocol: 1, operationId: "ns-1", type: "create", outcome: "conflict", reason: "path-taken", phase: "failed", canonicalPath: "notes/a.md", binding: null };
    expect(isNamespaceResult(result)).toBe(true);
    expect(isNamespaceResult({ ...result, phase: "half-way" })).toBe(false);
    expect(isNamespaceResult({ ...result, binding: { canonicalPath: "notes/a.md", documentId: null, epoch: 0, state: "deleted" } })).toBe(false);
  });
});

describe("conflict identity", () => {
  it("changes when any observing fact changes", () => {
    const base = conflictIdentity([1, "kb", DOCUMENT, 3, "a.md", "etag-1", "local-hash", "remote-hash"]);
    expect(conflictIdentity([1, "kb", DOCUMENT, 3, "a.md", "etag-1", "local-hash", "remote-hash"])).toBe(base);
    expect(conflictIdentity([1, "kb", DOCUMENT, 4, "a.md", "etag-1", "local-hash", "remote-hash"])).not.toBe(base);
    expect(conflictIdentity([1, "kb", DOCUMENT, 3, "a.md", "etag-2", "local-hash", "remote-hash"])).not.toBe(base);
  });
});

describe("content hashing", () => {
  it("hashes the markdown bytes, so a client can compare it against a file", async () => {
    const hash = await hotContentHash("hello\n");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hotContentHash(new TextEncoder().encode("hello\n"))).toBe(hash);
    expect(await hotContentHash("hello")).not.toBe(hash);
  });

  it("round-trips payloads and refuses junk", () => {
    const bytes = new Uint8Array([0, 1, 250, 255]);
    const encoded = encodeHotPayload(bytes);
    expect([...decodeHotPayload(encoded)!]).toEqual([...bytes]);
    expect(decodeHotPayload("!!!")).toBeUndefined();
    expect(decodeHotPayload(undefined)).toBeUndefined();
  });
});
