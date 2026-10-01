import { WorkerEntrypoint } from "cloudflare:workers";
import type { MarkRemoteDirtyRequest, MarkRemoteDirtyResult } from "@mineral/sync-core/sync-change";
import { createGatewayWebSocketTicket, isRemoteChangeChannel } from "@mineral/sync-core/gateway-protocol";
import { isAuthorized, isSubscribeAuthorized } from "./auth";
import { handleHotRoute, hotAction, type HotRouteEnv } from "./hot-routes";
import { NamespaceCoordinator } from "./namespace-coordinator";
import { RemoteChangeHub } from "./remote-change-hub";
import { handleMutationReport, type VaultMutationBinding } from "./mutations";
import { parseDirtyRequest, validRpcRequest } from "./validation";
import { handleDeletionIndex } from "./deletions";

export { RemoteChangeHub } from "./remote-change-hub";
export { NamespaceCoordinator } from "./namespace-coordinator";
export { LiveDocumentRoom } from "./live-document-room";
export { handleMutationReport, verdictStatus, type VaultMutationBinding } from "./mutations";

export type GatewayEnv = HotRouteEnv & {
  REMOTE_CHANGE_HUB: DurableObjectNamespace<RemoteChangeHub>;
  SYNC_GATEWAY_TOKEN: string;
  /**
   * The Vault, for the one thing a client cannot be trusted to do itself: reporting a mutation that
   * must be verified against R2, and the hot checkpoint acts only the Vault may perform. The Gateway
   * relays and returns the verdict; it holds no R2 credential and reads no object.
   */
  VAULT?: VaultMutationBinding;
};

/** Long enough to open a socket, short enough that a leaked ticket is worthless. */
const WEBSOCKET_TICKET_TTL_MS = 60_000;

type GatewayAction = "read" | "dirty" | "subscribe" | "ticket" | "mutations" | "deletions";

const noStore = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: noStore });

/** The `/v1/channels/{channel}/hot/...` half of the control plane. */
const HOT_ROUTE = /^\/v1\/channels\/([^/]+)\/(hot\/[A-Za-z/-]+)$/;

function route(pathname: string): { channel: string; action: GatewayAction } | null {
  const match = /^\/v1\/channels\/([^/]+)(?:\/(dirty|subscribe|ticket|mutations|deletions))?$/.exec(pathname);
  if (!match || !isRemoteChangeChannel(match[1])) return null;
  const action: GatewayAction = match[2] === "dirty" ? "dirty"
    : match[2] === "subscribe" ? "subscribe"
      : match[2] === "ticket" ? "ticket"
        : match[2] === "mutations" ? "mutations"
          : match[2] === "deletions" ? "deletions"
          : "read";
  return { channel: match[1], action };
}

export async function markRemoteDirtyInternal(env: GatewayEnv, input: MarkRemoteDirtyRequest): Promise<MarkRemoteDirtyResult> {
  if (!validRpcRequest(input)) throw new TypeError("invalid markRemoteDirty request");
  return env.REMOTE_CHANGE_HUB.getByName(input.channel).markDirty({ changes: input.changes, mutationId: input.mutationId });
}

export class SyncGatewayEntrypoint extends WorkerEntrypoint<GatewayEnv> {
  async markRemoteDirty(request: MarkRemoteDirtyRequest): Promise<MarkRemoteDirtyResult> {
    return markRemoteDirtyInternal(this.env, request);
  }
}

export default class SyncGateway extends WorkerEntrypoint<GatewayEnv> {
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // Hot sessions are routed first, and separately, because their authentication is different in one
    // specific way: a WebSocket cannot carry a header, so the hot session route is authorized by a
    // ticket that is scoped to one document epoch and one client. Everything else in this worker keeps
    // the original rule — bearer only, checked before any Durable Object is addressed.
    const hot = HOT_ROUTE.exec(pathname);
    if (hot && isRemoteChangeChannel(hot[1])) {
      const action = hotAction(hot[2]);
      if (!action) return error(404, "not_found");
      if (action !== "session" && !(await isAuthorized(request, this.env.SYNC_GATEWAY_TOKEN))) return error(401, "unauthorized");
      return (await handleHotRoute(request, hot[1], action, this.env)) ?? error(404, "not_found");
    }
    const parsed = route(pathname);
    if (!parsed) return pathname.startsWith("/v1/channels/") ? error(400, "invalid_channel") : error(404, "not_found");
    if (parsed.action === "subscribe" && request.method !== "GET") return error(405, "method_not_allowed");
    if (parsed.action === "read" && request.method !== "GET") return error(405, "method_not_allowed");
    if (parsed.action === "ticket" && request.method !== "POST") return error(405, "method_not_allowed");
    if (parsed.action === "dirty" && request.method !== "POST") return error(405, "method_not_allowed");
    if (parsed.action === "mutations" && request.method !== "POST") return error(405, "method_not_allowed");
    if (parsed.action === "deletions" && request.method !== "GET") return error(405, "method_not_allowed");
    // Every route authenticates here, before any Durable Object is addressed. A WebSocket route may
    // use either the bearer credential or a short-lived ticket; nothing else is accepted.
    const authorized = parsed.action === "subscribe"
      ? await isSubscribeAuthorized(request, parsed.channel, this.env.SYNC_GATEWAY_TOKEN, Date.now())
      : await isAuthorized(request, this.env.SYNC_GATEWAY_TOKEN);
    if (!authorized) return error(401, "unauthorized");
    if (parsed.action === "ticket") {
      // The ticket exchange itself requires the bearer token, so a ticket can never mint a ticket.
      return Response.json(await createGatewayWebSocketTicket({
        channel: parsed.channel,
        secret: this.env.SYNC_GATEWAY_TOKEN,
        ttlMs: WEBSOCKET_TICKET_TTL_MS,
        now: Date.now(),
      }), { headers: noStore });
    }
    if (parsed.action === "subscribe") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "websocket_upgrade_required");
      return this.env.REMOTE_CHANGE_HUB.getByName(parsed.channel).fetch(new Request("https://hub.internal/subscribe", { headers: { Upgrade: "websocket" } }));
    }
    if (parsed.action === "read") return Response.json(await this.env.REMOTE_CHANGE_HUB.getByName(parsed.channel).getGeneration(), { headers: noStore });
    // A reported mutation is relayed to its owner for verification, and the verdict comes back out.
    if (parsed.action === "mutations") return handleMutationReport(request, parsed.channel, this.env.VAULT);
    if (parsed.action === "deletions") return handleDeletionIndex(request, parsed.channel, this.env.VAULT);
    try {
      const input = await parseDirtyRequest(request, parsed.channel);
      if (!input) return error(request.headers.get("Content-Length") && Number(request.headers.get("Content-Length")) > 8192 ? 413 : 400, "invalid_request");
      return Response.json(await markRemoteDirtyInternal(this.env, input), { headers: noStore });
    } catch {
      return error(400, "invalid_request");
    }
  }
}
