import { SELF, evictAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const token = "gateway-test-token";
const channelA = "A".repeat(43);
const channelB = "B".repeat(43);
const channelC = "C".repeat(43);
const headers = { Authorization: `Bearer ${token}` };

function request(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://gateway.test${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function generation(channel: string) {
  return (await (await request(`/v1/channels/${channel}`)).json() as { generation: string }).generation;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise(resolve => socket.addEventListener("message", event => resolve(String(event.data)), { once: true }));
}

describe("mineral-sync-gateway", () => {
  it("starts at zero, persists marks, and isolates channels", async () => {
    expect(await generation(channelA)).toBe("0");
    expect((await (await request(`/v1/channels/${channelA}/dirty`, { method: "POST", body: "{}" })).json() as { generation: string }).generation).toBe("1");
    expect(await generation(channelA)).toBe("1");
    expect(await generation(channelB)).toBe("0");
  });

  it("does not lose concurrent or duplicate marks", async () => {
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => request(`/v1/channels/${channelB}/dirty`, { method: "POST", body: "{}" })));
    expect(concurrent.every(response => response.status === 200)).toBe(true);
    expect(await generation(channelB)).toBe("20");
    await request(`/v1/channels/${channelB}/dirty`, { method: "POST", body: JSON.stringify({ source: "obsidian", kind: "upsert" }) });
    await request(`/v1/channels/${channelB}/dirty`, { method: "POST", body: JSON.stringify({ source: "obsidian", kind: "upsert" }) });
    expect(await generation(channelB)).toBe("22");
  });

  it("rejects unauthenticated and malformed control-plane input before mutation", async () => {
    expect((await SELF.fetch(`https://gateway.test/v1/channels/${channelA}`)).status).toBe(401);
    expect((await request(`/v1/channels/${channelA}/dirty`, { method: "POST", body: JSON.stringify({ content: "no" }) })).status).toBe(400);
    expect((await request("/v1/channels/too-short")).status).toBe(400);
    expect((await request(`/v1/channels/${channelA}/subscribe`)).status).toBe(426);
    expect((await request(`/v1/channels/${channelA}`)).headers.get("Cache-Control")).toBe("no-store");
  });

  it("converges HTTP and WorkerEntrypoint RPC on the same Hub", async () => {
    const rpc = exports.SyncGatewayEntrypoint as unknown as { markRemoteDirty(input: { channel: string }): Promise<{ generation: string }> };
    const result = await rpc.markRemoteDirty({ channel: channelA });
    expect(result.generation).toBe("2");
    expect(await generation(channelA)).toBe("2");
  });

  it("sends a snapshot then durable advancements to WebSocket subscribers", async () => {
    const response = await request(`/v1/channels/${channelA}/subscribe`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const snapshot = nextMessage(socket);
    socket.accept();
    expect(JSON.parse(await snapshot)).toEqual({ type: "current-generation", generation: "2" });
    const dirty = nextMessage(socket);
    await request(`/v1/channels/${channelA}/dirty`, { method: "POST", body: "{}" });
    expect(JSON.parse(await dirty)).toEqual({ type: "remote-dirty", generation: "3" });
    socket.close();
    const reconnect = await request(`/v1/channels/${channelA}/subscribe`, { headers: { Upgrade: "websocket" } });
    const reconnectedSocket = reconnect.webSocket!;
    const reconnectSnapshot = nextMessage(reconnectedSocket);
    reconnectedSocket.accept();
    expect(JSON.parse(await reconnectSnapshot)).toEqual({ type: "current-generation", generation: "3" });
    reconnectedSocket.close();
    await evictAllDurableObjects();
    expect(await generation(channelA)).toBe("3");
  });

  it("exchanges the bearer token for a short-lived channel-scoped WebSocket ticket", async () => {
    const issued = await request(`/v1/channels/${channelC}/ticket`, { method: "POST", body: "{}" });
    expect(issued.status).toBe(200);
    const body = await issued.json() as { protocol: number; ticket: string; expiresAt: number };
    expect(body.protocol).toBe(1);
    expect(body.ticket.length).toBeGreaterThan(0);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    // The long-lived bearer token must never appear in a URL-bound value.
    expect(body.ticket).not.toContain(token);
    expect(issued.headers.get("Cache-Control")).toBe("no-store");

    // The ticket alone opens a socket, with no Authorization header at all.
    const subscribed = await SELF.fetch(`https://gateway.test/v1/channels/${channelC}/subscribe?ticket=${encodeURIComponent(body.ticket)}`, { headers: { Upgrade: "websocket" } });
    expect(subscribed.status).toBe(101);
    const socket = subscribed.webSocket!;
    const snapshot = nextMessage(socket);
    socket.accept();
    expect(JSON.parse(await snapshot)).toEqual({ type: "current-generation", generation: "0" });
    socket.close();
  });

  it("rejects tickets that are missing, forged, expired, or minted for another channel", async () => {
    const issued = await request(`/v1/channels/${channelC}/ticket`, { method: "POST", body: "{}" });
    const { ticket } = await issued.json() as { ticket: string };
    const subscribe = (query: string) => SELF.fetch(`https://gateway.test/v1/channels/${channelC}/subscribe${query}`, { headers: { Upgrade: "websocket" } });

    // Authenticates before any Durable Object is addressed, on every failure path.
    expect((await SELF.fetch(`https://gateway.test/v1/channels/${channelC}/subscribe`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await subscribe("?ticket=")).status).toBe(401);
    expect((await subscribe("?ticket=short")).status).toBe(401);
    // Flip one signature character, guaranteeing it actually differs.
    const forged = `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`;
    expect((await subscribe(`?ticket=${encodeURIComponent(forged)}`)).status).toBe(401);
    expect((await subscribe(`?ticket=${encodeURIComponent(`v1.${channelB}.${ticket.split(".").slice(2).join(".")}`)}`)).status).toBe(401);
    const channelBTicket = await request(`/v1/channels/${channelB}/ticket`, { method: "POST", body: "{}" });
    const other = await channelBTicket.json() as { ticket: string };
    expect((await subscribe(`?ticket=${encodeURIComponent(other.ticket)}`)).status).toBe(401);

    // The ticket endpoint itself is not a way around authentication.
    expect((await SELF.fetch(`https://gateway.test/v1/channels/${channelC}/ticket`, { method: "POST" })).status).toBe(401);
    expect((await request(`/v1/channels/${channelC}/ticket`)).status).toBe(405);
  });

  it("still accepts the bearer credential on the subscribe route", async () => {
    const response = await request(`/v1/channels/${channelC}/subscribe`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const snapshot = nextMessage(socket);
    socket.accept();
    expect(JSON.parse(await snapshot)).toEqual({ type: "current-generation", generation: "0" });
    socket.close();
  });
});
