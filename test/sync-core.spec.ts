import { describe, expect, it } from "vitest";
import {
  canonicalChannelInput,
  canonicalEndpoint,
  canonicalPrefix,
  deriveRemoteChangeChannel,
  isRemoteChangeChannel,
} from "@mineral/sync-core/channel";
import {
  createGatewayWebSocketTicket,
  isGatewayGenerationSnapshot,
  isGatewayWebSocketTicket,
  verifyGatewayWebSocketTicket,
} from "@mineral/sync-core/gateway-protocol";
import { parseSubscribeMessage } from "@mineral/sync-core/gateway-subscribe";
import {
  advanceAnnouncedGeneration,
  compareRemoteGeneration,
  confirmReconciledGeneration,
  emptyGenerationCursor,
  formatRemoteGeneration,
  isRemoteGeneration,
  isRemoteReconcilePending,
  parseGenerationCursor,
  parseRemoteGeneration,
} from "@mineral/sync-core/sync-change";

const identity = (overrides: Partial<{ endpoint: string; bucket: string; remotePrefix: string }> = {}) => ({
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "vault",
  remotePrefix: "notes",
  ...overrides,
});

describe("canonical channel identity", () => {
  it("normalizes endpoint and prefix exactly like the plugin's RemoteIdentity", () => {
    expect(canonicalEndpoint("https://account.r2.cloudflarestorage.com/")).toBe("https://account.r2.cloudflarestorage.com");
    expect(canonicalEndpoint("")).toBe("");
    expect(canonicalPrefix("notes")).toBe("notes/");
    expect(canonicalPrefix("notes/")).toBe("notes/");
    expect(canonicalPrefix("/notes//")).toBe("notes/");
    expect(canonicalPrefix("  ")).toBe("");
    expect(canonicalPrefix("a\\b")).toBe("a/b/");
  });

  it("uses a length-prefixed, versioned input so field boundaries cannot be confused", () => {
    // Without length prefixes, "a" + "bc" and "ab" + "c" would hash identically.
    expect(canonicalChannelInput(identity({ bucket: "a", remotePrefix: "bc" })))
      .not.toBe(canonicalChannelInput(identity({ bucket: "ab", remotePrefix: "c" })));
    expect(canonicalChannelInput(identity())).toBe("v1:40:https://account.r2.cloudflarestorage.com:5:vault:6:notes/");
  });

  it("derives one stable 43-character channel for one namespace", async () => {
    const channel = await deriveRemoteChangeChannel(identity());
    expect(channel).toHaveLength(43);
    expect(isRemoteChangeChannel(channel)).toBe(true);
    // Trailing slashes and whitespace are the same namespace, on every platform.
    await expect(deriveRemoteChangeChannel({ endpoint: "https://account.r2.cloudflarestorage.com/", bucket: " vault ", remotePrefix: "/notes" })).resolves.toBe(channel);
  });

  it("separates distinct namespaces", async () => {
    const base = await deriveRemoteChangeChannel(identity());
    const channels = await Promise.all([
      deriveRemoteChangeChannel(identity({ bucket: "other" })),
      deriveRemoteChangeChannel(identity({ remotePrefix: "other" })),
      deriveRemoteChangeChannel(identity({ remotePrefix: "" })),
      deriveRemoteChangeChannel(identity({ endpoint: "https://other.r2.cloudflarestorage.com" })),
    ]);
    for (const channel of channels) expect(channel).not.toBe(base);
    expect(new Set([base, ...channels]).size).toBe(5);
  });

  it("pins the derivation vector that the plugin must reproduce byte for byte", async () => {
    // This value is the cross-repository contract. If it changes, an already-deployed plugin
    // silently stops sharing a channel with the Gateway and the backend hashes differently.
    await expect(deriveRemoteChangeChannel({ endpoint: "https://example.r2.cloudflarestorage.com", bucket: "b", remotePrefix: "p" }))
      .resolves.toBe("nxJOCorDX1N0B_ro3-l8uQeOmhwj1pv39_mHHTPACOk");
    await expect(deriveRemoteChangeChannel(identity()))
      .resolves.toBe("D3BD_N3xF3hBqgXAmhjUGvKbiwEYzQlM34Y-ShCa8vY");
  });
});

describe("remote generation cursor", () => {
  it("parses and compares decimal strings without Number precision loss", () => {
    expect(isRemoteGeneration("0")).toBe(true);
    expect(isRemoteGeneration("007")).toBe(false);
    expect(isRemoteGeneration(7)).toBe(false);
    expect(isRemoteGeneration("-1")).toBe(false);
    expect(parseRemoteGeneration("12")).toBe(12n);
    expect(parseRemoteGeneration("nope")).toBeUndefined();
    expect(formatRemoteGeneration(0n)).toBe("0");
    const huge = "9007199254740993";
    expect(compareRemoteGeneration(huge, "9007199254740992")).toBe(1);
    // The same comparison through Number would call these equal.
    expect(Number(huge) === Number("9007199254740992")).toBe(true);
  });

  it("treats malformed persisted cursors as empty instead of trusting them", () => {
    expect(parseGenerationCursor(undefined)).toEqual(emptyGenerationCursor());
    expect(parseGenerationCursor({ highestAnnouncedGeneration: "5" })).toEqual({ highestAnnouncedGeneration: "5", lastReconciledGeneration: "0" });
    expect(parseGenerationCursor({ highestAnnouncedGeneration: 5, lastReconciledGeneration: "x" })).toEqual(emptyGenerationCursor());
  });

  it("keeps announced and confirmed cursors independent", () => {
    let cursor = emptyGenerationCursor();
    cursor = advanceAnnouncedGeneration(cursor, "10");
    expect(cursor).toEqual({ highestAnnouncedGeneration: "10", lastReconciledGeneration: "0" });
    expect(isRemoteReconcilePending(cursor)).toBe(true);
    // Announcing never confirms.
    cursor = advanceAnnouncedGeneration(cursor, "9");
    expect(cursor.highestAnnouncedGeneration).toBe("10");
    cursor = confirmReconciledGeneration(cursor, "10");
    expect(isRemoteReconcilePending(cursor)).toBe(false);
    // Confirming never goes backwards.
    expect(confirmReconciledGeneration(cursor, "4")).toEqual(cursor);
    expect(advanceAnnouncedGeneration(cursor, "junk")).toEqual(cursor);
  });

  it("keeps a confirmed cursor pending again after a later announcement", () => {
    let cursor = confirmReconciledGeneration(advanceAnnouncedGeneration(emptyGenerationCursor(), "10"), "10");
    cursor = advanceAnnouncedGeneration(cursor, "11");
    expect(cursor).toEqual({ highestAnnouncedGeneration: "11", lastReconciledGeneration: "10" });
    expect(isRemoteReconcilePending(cursor)).toBe(true);
  });
});

describe("subscribe message validation", () => {
  it("accepts only the two closed protocol frames", () => {
    expect(parseSubscribeMessage(JSON.stringify({ type: "current-generation", generation: "0" }))).toEqual({ type: "current-generation", generation: "0" });
    expect(parseSubscribeMessage(JSON.stringify({ type: "remote-dirty", generation: "1843" }))).toEqual({ type: "remote-dirty", generation: "1843" });
  });

  it("rejects junk, unknown types, and non-canonical generations", () => {
    for (const payload of [
      "not json",
      "[]",
      "null",
      '"remote-dirty"',
      JSON.stringify({ type: "delete", generation: "1" }),
      JSON.stringify({ type: "remote-dirty" }),
      JSON.stringify({ type: "remote-dirty", generation: 11 }),
      JSON.stringify({ type: "remote-dirty", generation: "-1" }),
      JSON.stringify({ type: "remote-dirty", generation: "01" }),
      JSON.stringify({ type: "remote-dirty", generation: "1e3" }),
      JSON.stringify({ type: "REMOTE-DIRTY", generation: "1" }),
      JSON.stringify({ type: "remote-dirty", generation: "1", path: "secret.md" }),
    ]) expect(parseSubscribeMessage(payload)).toBeUndefined();
  });
});

describe("websocket ticket", () => {
  const secret = "gateway-test-token";
  const channel = "A".repeat(43);

  it("issues a channel-scoped, short-lived, signed ticket", async () => {
    const now = 1_700_000_000_000;
    const issued = await createGatewayWebSocketTicket({ channel, secret, ttlMs: 60_000, now });
    expect(isGatewayWebSocketTicket(issued)).toBe(true);
    expect(issued.expiresAt).toBe(now + 60_000);
    // No long-lived bearer and no R2 material ever appears in the URL-bound value.
    expect(issued.ticket).not.toContain(secret);
    expect(issued.ticket.startsWith(`v1.${channel}.`)).toBe(true);
    await expect(verifyGatewayWebSocketTicket({ ticket: issued.ticket, channel, secret, now })).resolves.toBe(true);
  });

  it("rejects a ticket for another channel, an expired ticket, a tampered ticket, and a wrong secret", async () => {
    const now = 1_700_000_000_000;
    const issued = await createGatewayWebSocketTicket({ channel, secret, ttlMs: 60_000, now });
    await expect(verifyGatewayWebSocketTicket({ ticket: issued.ticket, channel: "B".repeat(43), secret, now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: issued.ticket, channel, secret, now: now + 60_001 })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: issued.ticket, channel, secret: "other", now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: `${issued.ticket}x`, channel, secret, now })).resolves.toBe(false);
    // Flip one character of the signature, not of the signed payload.
    const flipped = `${issued.ticket.slice(0, -1)}${issued.ticket.endsWith("A") ? "B" : "A"}`;
    await expect(verifyGatewayWebSocketTicket({ ticket: flipped, channel, secret, now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: `v2.${issued.ticket.split(".").slice(1).join(".")}`, channel, secret, now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: undefined, channel, secret, now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: "a.b.c.d", channel, secret, now })).resolves.toBe(false);
    await expect(verifyGatewayWebSocketTicket({ ticket: issued.ticket, channel, secret: "", now })).resolves.toBe(false);
  });

  it("refuses to mint a ticket for a non-canonical channel or an empty secret", async () => {
    await expect(createGatewayWebSocketTicket({ channel: "short", secret, ttlMs: 1000, now: 0 })).rejects.toThrow();
    await expect(createGatewayWebSocketTicket({ channel, secret: "", ttlMs: 1000, now: 0 })).rejects.toThrow();
  });

  it("validates generation snapshots", () => {
    expect(isGatewayGenerationSnapshot({ generation: "0" })).toBe(true);
    expect(isGatewayGenerationSnapshot({ generation: 0 })).toBe(false);
    expect(isGatewayGenerationSnapshot(null)).toBe(false);
    expect(isGatewayGenerationSnapshot({ generation: "0", extra: true })).toBe(true);
  });
});
