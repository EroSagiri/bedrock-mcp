import type { VaultHotRpc } from "@mineral/core/vault-rpc";
import {
  COLD_AUTHORITY_TTL_MS,
  createHotSessionTicket,
  isColdAuthorityCommit,
  isColdAuthorityRequest,
  isHotAcquireRequest,
  isHotConflictResolution,
  isHotMergedResolution,
  isHotReleaseRequest,
  verifyHotSessionTicket,
} from "@mineral/sync-core/hot-protocol";
import { isNamespaceIntent } from "@mineral/sync-core/namespace-protocol";
import type { LiveDocumentRoom } from "./live-document-room";
import type { ColdCommitOutcome, NamespaceCoordinator } from "./namespace-coordinator";

/**
 * The hot-session HTTP surface.
 *
 * It is deliberately a *relay* with three jobs and no decisions of its own: authenticate, hand the
 * caller to the object that owns the answer (the knowledge base's Namespace Coordinator), and mint the
 * short-lived credential a WebSocket needs. Every semantic answer — may this path be opened, what is
 * its binding, was that rename applied — comes from a Durable Object, so there is exactly one place
 * where namespace truth lives.
 *
 * Hot routes sit under the existing `/v1/channels/{channel}` prefix for the same reason the original
 * control plane did: the channel is derived from the R2 identity both sides already agree on, and it
 * is the scope every authorization decision is made in. A caller that knows a document id but not the
 * channel cannot reach the document.
 */

/** Control bodies are small by construction: an id, a path, a hash. */
export const MAX_HOT_CONTROL_BYTES = 16 * 1024;
/** Long enough to open a socket, short enough that a leaked ticket is worthless. */
const HOT_TICKET_TTL_MS = 60_000;

export type HotRouteEnv = {
  SYNC_GATEWAY_TOKEN: string;
  COORDINATOR: DurableObjectNamespace<NamespaceCoordinator>;
  ROOM: DurableObjectNamespace<LiveDocumentRoom>;
  VAULT?: VaultHotRpc;
};

export type HotAction = "acquire" | "release" | "path" | "namespace" | "resolve" | "cold-acquire" | "cold-commit" | "cold-release" | "session" | "health";

const noStore = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (status: number, body: unknown) => Response.json(body as Record<string, unknown>, { status, headers: noStore });

/**
 * Matches the hot sub-paths of a channel route.
 *
 * `null` means "not a hot route", so the caller falls through to the existing control-plane handling
 * rather than this module answering 404 for the whole prefix.
 */
export function hotAction(remainder: string): HotAction | null {
  switch (remainder) {
    case "hot/acquire": return "acquire";
    case "hot/release": return "release";
    case "hot/path": return "path";
    case "hot/namespace": return "namespace";
    case "hot/cold/acquire": return "cold-acquire";
    case "hot/cold/commit": return "cold-commit";
    case "hot/cold/release": return "cold-release";
    case "hot/resolve": return "resolve";
    case "hot/session": return "session";
    case "hot/health": return "health";
    default: return null;
  }
}

async function readBody(request: Request, limit = MAX_HOT_CONTROL_BYTES): Promise<unknown> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) return undefined;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Handles one hot route, or returns `null` when the action is not a hot one.
 *
 * The caller has already authenticated the request and validated the channel; this function never
 * re-derives either, because a second derivation of an authorization fact is a second chance to get it
 * wrong.
 */
export async function handleHotRoute(
  request: Request,
  channel: string,
  action: HotAction,
  env: HotRouteEnv,
  now = Date.now(),
): Promise<Response | null> {
  const coordinator = env.COORDINATOR.getByName(channel);

  if (action === "session") {
    const ticket = new URL(request.url).searchParams.get("ticket") ?? undefined;
    const verified = await verifyHotSessionTicket({ ticket, channel, secret: env.SYNC_GATEWAY_TOKEN, now });
    if (!verified) return json(401, { error: "unauthorized" });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "websocket_upgrade_required" });
    // The document and client identity come from the signed ticket, never from a header the caller
    // could have supplied itself.
    const room = env.ROOM.getByName(verified.documentId);
    return room.fetch(new Request("https://room.internal/session", {
      headers: { Upgrade: "websocket", "X-Hot-Client": verified.clientId, "X-Hot-Epoch": String(verified.epoch) },
    }));
  }

  if (action === "health") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, await coordinator.health());
  }

  if (action === "path") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const path = new URL(request.url).searchParams.get("path") ?? "";
    return json(200, new URL(request.url).searchParams.get("resolution") === "1" ? await coordinator.resolutionSnapshot(path) : await coordinator.pathStatus({ canonicalPath: path }));
  }

  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const body = await readBody(request, action === "resolve" ? 7 * 1024 * 1024 : MAX_HOT_CONTROL_BYTES);
  if (body === undefined) return json(400, { error: "invalid_request" });

  if (action === "acquire") {
    if (!isHotAcquireRequest(body)) return json(400, { error: "invalid_request" });
    const acquired = await coordinator.acquire(body);
    if ((acquired.outcome === "joined" || acquired.outcome === "created") && acquired.identity && body.wantSession) {
      const ticket = await createHotSessionTicket({
        channel,
        documentId: acquired.identity.documentId,
        epoch: acquired.identity.epoch,
        clientId: body.clientId,
        secret: env.SYNC_GATEWAY_TOKEN,
        ttlMs: HOT_TICKET_TTL_MS,
        now,
      });
      return json(200, { ...acquired, sessionTicket: ticket.ticket, ticketExpiresAt: ticket.expiresAt });
    }
    return json(acquired.outcome === "rejected" ? 409 : 200, acquired);
  }

  if (action === "release") {
    if (!isHotReleaseRequest(body)) return json(400, { error: "invalid_request" });
    return json(200, await coordinator.release(body));
  }

  if (action === "namespace") {
    if (!isNamespaceIntent(body)) return json(400, { error: "invalid_request" });
    const result = await coordinator.namespace(body);
    return json(result.outcome === "applied" ? 200 : result.outcome === "pending" ? 202 : 409, result);
  }

  if (action === "resolve") {
    if (isHotMergedResolution(body)) return json(200, await coordinator.applyMergedResolution(body));
    if (!isHotConflictResolution(body)) return json(400, { error: "invalid_request" });
    const resolved = await coordinator.resolveHotConflict(body);
    return json(resolved.outcome === "not-found" ? 404 : 200, resolved);
  }

  if (action === "cold-acquire") {
    if (!isColdAuthorityRequest(body)) return json(400, { error: "invalid_request" });
    const result = await coordinator.coldAcquire(body);
    return json(result.outcome === "granted" ? 200 : 409, result);
  }

  if (action === "cold-commit") {
    if (!isColdAuthorityCommit(body)) return json(400, { error: "invalid_request" });
    const result: ColdCommitOutcome = await coordinator.coldCommit(body);
    return json(result.outcome === "recorded" ? 200 : 409, result);
  }

  if (action === "cold-release") {
    const token = (body as { token?: unknown }).token;
    if (typeof token !== "string" || token.length === 0) return json(400, { error: "invalid_request" });
    return json(200, { released: await coordinator.coldRelease({ token }) });
  }

  return null;
}

/** The lease TTL, exposed so the plugin's diagnostics can report it without importing the object. */
export { COLD_AUTHORITY_TTL_MS };

