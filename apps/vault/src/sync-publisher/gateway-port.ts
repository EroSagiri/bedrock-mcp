import type { MutationEvent } from "../mutation/types";

/**
 * The Gateway port.
 *
 * The publisher knows exactly this much about the sync gateway: hand it a mutation, get back a
 * generation or a reason. It does not know about channels, hubs, sockets, tokens, or RPC — that is
 * what keeps "Vault → Sync Gateway" a one-way delivery dependency instead of a cycle.
 */
export type GatewayPublishResult =
  | { ok: true; generation: string }
  | { ok: false; kind: "transport" | "auth" | "server" | "client" | "disabled" | "malformed" };

export type GatewayPublisher = {
  /** `mutationId` rides along so a redelivery cannot mint a second generation. */
  publish(event: MutationEvent & { mutationId: string }): Promise<GatewayPublishResult>;
};

/** The gateway's only vocabulary for a knowledge-base write. */
export function gatewayChangesFor(event: MutationEvent): Array<{ op: "put"; path: string; etag?: string; size?: number } | { op: "delete"; path: string }> {
  if (event.op === "delete") return [{ op: "delete", path: event.path }];
  return [{ op: "put", path: event.path, ...(event.etag ? { etag: event.etag } : {}), ...(typeof event.size === "number" ? { size: event.size } : {}) }];
}

/** Only the digest of a failure is ever stored; a gateway body can contain anything. */
export function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}
