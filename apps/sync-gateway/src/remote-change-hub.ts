import { DurableObject } from "cloudflare:workers";
import type { MarkRemoteDirtyRequest, MarkRemoteDirtyResult, RemoteGeneration } from "@mineral/sync-core/sync-change";

const GENERATION_KEY = "generation";
const noStore = { "Cache-Control": "no-store" };

export class RemoteChangeHub extends DurableObject {
  private async generation(): Promise<bigint> {
    return BigInt((await this.ctx.storage.get<string>(GENERATION_KEY)) ?? "0");
  }

  async getGeneration(): Promise<MarkRemoteDirtyResult> {
    return { generation: (await this.generation()).toString() };
  }

  async markDirty(input: Pick<MarkRemoteDirtyRequest, "changes"> = {}): Promise<MarkRemoteDirtyResult> {
    const generation = await this.ctx.storage.transaction(async transaction => {
      const current = BigInt((await transaction.get<string>(GENERATION_KEY)) ?? "0");
      const next = (current + 1n).toString();
      await transaction.put(GENERATION_KEY, next);
      return next;
    });
    this.broadcast(generation, input.changes);
    return { generation };
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/subscribe") return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ protocol: 1 });
    server.send(JSON.stringify({ type: "current-generation", generation: (await this.generation()).toString() }));
    return new Response(null, { status: 101, webSocket: client, headers: noStore });
  }

  webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): void {
    // The v1 socket is server-to-client only; inbound messages carry no meaning.
  }

  webSocketClose(_socket: WebSocket, _code: number, _reason: string): void {
    // The runtime handles the close reply; no per-socket state is retained.
  }

  private broadcast(generation: RemoteGeneration, changes: MarkRemoteDirtyRequest["changes"]): void {
    const scoped = changes?.length ? JSON.stringify({ type: "remote-change", generation, changes }) : undefined;
    const payload = JSON.stringify({ type: "remote-dirty", generation });
    for (const socket of this.ctx.getWebSockets()) {
      try { if (scoped) socket.send(scoped); socket.send(payload); } catch { try { socket.close(1011, "send failed"); } catch {} }
    }
  }
}
