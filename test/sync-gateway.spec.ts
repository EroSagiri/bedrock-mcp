import { SELF, evictAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const token = "gateway-test-token";
const channelA = "A".repeat(43);
const channelB = "B".repeat(43);
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
});
