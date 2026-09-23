import { isReportedMutation, isMutationVerdict, type MutationVerdict, type ReportedMutation } from "@mineral/sync-core/sync-change";

/**
 * The Vault, as the Gateway needs it: one method that records a reported mutation.
 *
 * A structural type rather than an import from the Vault app, because the Gateway must not depend on
 * the Vault's implementation — only on this contract. It is the mirror of `GatewayRpcBinding` on the
 * other side of the same pair.
 */
export type VaultMutationBinding = {
  recordReportedMutation(request: ReportedMutation): Promise<MutationVerdict>;
};

/** The Vault's own body limit for a report; a mutation is a fact, not a payload. */
export const MAX_REPORT_BYTES = 8 * 1024;

const noStore = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: noStore });

/** The status a verdict becomes on the wire, so a client can tell retry from give up. */
export function verdictStatus(verdict: MutationVerdict): number {
  if (verdict.verdict === "accepted" || verdict.verdict === "duplicate") return 202;
  if (verdict.reason === "state-mismatch") return 409;
  if (verdict.reason === "invalid") return 400;
  if (verdict.reason === "unknown-channel") return 404;
  return 503;
}

/**
 * `POST /v1/channels/{channel}/mutations` — a writer reporting an R2 change it performed.
 *
 * This is the Gateway acting as the single client control plane, not as an authority. It authenticates,
 * bounds the body, relays the report to the Vault over a service binding, and returns the Vault's
 * verdict unchanged. It reads no R2 object and decides nothing: verification and the journal stay with
 * the Vault, which is why the verdict has to travel back rather than being invented here.
 *
 * The client never learns where the Vault is, and a report cannot be lost by the relay answering early:
 * a relayed report returns the authority's answer, so `409` still means "do not retry this report".
 */
export async function handleMutationReport(
  request: Request,
  channel: string,
  vault: VaultMutationBinding | undefined,
): Promise<Response> {
  if (!vault) return json(503, { error: "mutations_unavailable" });

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REPORT_BYTES)) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_REPORT_BYTES) return json(413, { error: "too_large" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  if (!isReportedMutation(parsed)) return json(400, { error: "invalid_request" });

  let verdict: unknown;
  try {
    verdict = await vault.recordReportedMutation(parsed);
  } catch {
    // A relay that cannot reach the authority says "try again"; it never guesses an answer.
    return json(503, { error: "mutations_unavailable" });
  }
  if (!isMutationVerdict(verdict)) return json(503, { error: "mutations_unavailable" });
  return json(verdictStatus(verdict), verdict as unknown as Record<string, unknown>);
}
