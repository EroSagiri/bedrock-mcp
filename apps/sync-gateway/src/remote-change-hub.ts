import { DurableObject } from "cloudflare:workers";
import type { MarkRemoteDirtyRequest, MarkRemoteDirtyResult, RemoteGeneration } from "@mineral/sync-core/sync-change";

const GENERATION_KEY = "generation";
/**
 * How many writer mutation ids this Hub remembers.
 *
 * Delivery is fine while a writer can still retry, and a writer that has been retried thousands of
 * times over has long since fallen back to a full reconcile. The bound is what keeps a hostile or
 * broken client from growing this table without limit.
 */
const MUTATION_MEMORY = 4096;
const noStore = { "Cache-Control": "no-store" };

export class RemoteChangeHub extends DurableObject {
  /**
   * `mutation_id → generation`, so a repeated writer request is answered instead of minting a
   * second generation. The generation itself still moves exactly as before.
   */
  private dedupe(): SqlStorage {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutation_dedupe (
        mutation_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mutation_dedupe_created ON mutation_dedupe(created_at);
    `);
    return this.ctx.storage.sql;
  }

  private async generation(): Promise<bigint> {
    return BigInt((await this.ctx.storage.get<string>(GENERATION_KEY)) ?? "0");
  }

  async getGeneration(): Promise<MarkRemoteDirtyResult> {
    return { generation: (await this.generation()).toString() };
  }

  private remembered(mutationId: string): string | null {
    const rows = [...this.dedupe().exec<{ generation: string }>(
      "SELECT generation FROM mutation_dedupe WHERE mutation_id = ?",
      mutationId,
    )];
    return rows[0]?.generation ?? null;
  }

  private remember(mutationId: string, generation: string): void {
    const sql = this.dedupe();
    sql.exec(
      "INSERT OR REPLACE INTO mutation_dedupe (mutation_id, generation, created_at) VALUES (?, ?, ?)",
      mutationId,
      generation,
      Date.now(),
    );
    sql.exec(
      "DELETE FROM mutation_dedupe WHERE mutation_id IN (SELECT mutation_id FROM mutation_dedupe ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
      MUTATION_MEMORY,
    );
  }

  /**
   * A writer notification.
   *
   * Without a `mutationId` this is exactly the old level-triggered behaviour: one call, one
   * generation. With one, the call is idempotent — a redelivery of the same mutation returns the
   * original generation and broadcasts nothing, so a lost response can never produce generation 81
   * followed by 82 for one write.
   */
  async markDirty(input: Pick<MarkRemoteDirtyRequest, "changes" | "mutationId"> = {}): Promise<MarkRemoteDirtyResult> {
    const mutationId = input.mutationId;
    if (mutationId) {
      const existing = this.remembered(mutationId);
      if (existing !== null) return { generation: existing };
    }
    const generation = await this.ctx.storage.transaction(async transaction => {
      const current = BigInt((await transaction.get<string>(GENERATION_KEY)) ?? "0");
      const next = (current + 1n).toString();
      await transaction.put(GENERATION_KEY, next);
      return next;
    });
    if (mutationId) this.remember(mutationId, generation);
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
