import { mutationLog } from "../mutation/ids";
import type { MutationSource } from "../mutation/types";
import { gatewayChangesFor, boundedError, type GatewayPublisher, type GatewayPublishResult } from "./gateway-port";

/** The serializable request the gateway already understands, extended with the idempotency key. */
export type GatewayDirtyRequest = {
  channel: string;
  mutationId: string;
  source: MutationSource;
  kind: "upsert" | "delete";
  changes: ReturnType<typeof gatewayChangesFor>;
};

export type GatewayDirtyResult = { generation: string };

/** The RPC shape of `SyncGatewayEntrypoint.markRemoteDirty`; declared structurally on purpose. */
export type GatewayRpcBinding = {
  markRemoteDirty(request: GatewayDirtyRequest): Promise<GatewayDirtyResult>;
};

export type GatewayPublisherConfig = {
  channel: string | null;
  rpc?: GatewayRpcBinding;
  url?: string;
  token?: string;
  fetch?: typeof fetch;
};

function classify(status: number): GatewayPublishResult & { ok: false } {
  if (status === 401 || status === 403) return { ok: false, kind: "auth" };
  if (status >= 500) return { ok: false, kind: "server" };
  return { ok: false, kind: "client" };
}

/**
 * The concrete gateway consumer.
 *
 * Two transports, one contract: a Service Binding when the gateway is deployed beside the Vault
 * Worker, and a bearer-token POST when it is not. Neither one is allowed to make the caller fail —
 * the R2 write and the journal fact are already durable by the time anything here runs.
 */
export function createGatewayPublisher(config: GatewayPublisherConfig): GatewayPublisher {
  const channel = config.channel;
  const doFetch = config.fetch ?? fetch;
  const configured = Boolean(channel) && Boolean(config.rpc || config.url);
  if (!configured) mutationLog("mutation broadcast disabled");
  return {
    async publish(event) {
      if (!configured || !channel) return { ok: false, kind: "disabled" };
      const request: GatewayDirtyRequest = {
        channel,
        mutationId: event.mutationId,
        source: event.source,
        kind: event.op === "delete" ? "delete" : "upsert",
        changes: gatewayChangesFor(event),
      };
      if (config.rpc) {
        try {
          const result = await config.rpc.markRemoteDirty(request);
          if (typeof result?.generation === "string") return { ok: true, generation: result.generation };
          mutationLog("mutation broadcast rpc malformed", { id: event.mutationId });
          return { ok: false, kind: "malformed" };
        } catch (error) {
          // The RPC boundary is where a binding misconfiguration shows up; a bare kind would hide it.
          mutationLog("mutation broadcast rpc failed", { id: event.mutationId, error: boundedError(error).replace(/\s+/g, "_") });
          return { ok: false, kind: "transport" };
        }
      }
      try {
        const response = await doFetch(`${config.url!.replace(/\/+$/, "")}/v1/channels/${channel}/dirty`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
          body: JSON.stringify(request),
        });
        if (response.status < 200 || response.status >= 300) return classify(response.status);
        const parsed = await response.json<unknown>();
        const generation = (parsed as { generation?: unknown } | null)?.generation;
        return typeof generation === "string" ? { ok: true, generation } : { ok: false, kind: "malformed" };
      } catch {
        return { ok: false, kind: "transport" };
      }
    },
  };
}
