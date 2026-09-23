import { createMutationRecorder, type MutationRecorder } from "./recorder";
import type { MutationJournal } from "./store";
import type { MutationEvent } from "./types";
import { MAX_MUTATION_INGRESS_BYTES, MutationIngressError, isRemoteApply, normalizeEtag, parseIngressBody, recordVerifiedMutationOrThrow, type MutationWriteOrigin } from "./ingress";

export { MutationIngressError } from "./ingress";

export type MutationIngressService = {
  record(event: MutationEvent): Promise<{ status: "accepted" | "duplicate"; seq: number }>;
};

export type MutationIngressEnv = {
  MINERAL: R2Bucket;
  MUTATION_INGRESS_TOKEN?: string;
};

/**
 * R2 is the authority, so a report is checked against it.
 *
 * The client is saying "I already PUT this revision" (or "I already deleted it"), and only the
 * current object can confirm that. A stale or malicious ETag is rejected here rather than being
 * allowed to poison the journal, the gateway broadcast, or the index.
 */
export function createR2MutationVerifier(bucket: R2Bucket) {
  return {
    async observe(path: string): Promise<{ etag: string; size: number } | null> {
      const object = await bucket.head(path);
      return object ? { etag: normalizeEtag(object.etag), size: object.size } : null;
    },
  };
}

/**
 * The Obsidian-style ingress: a client reports a mutation it already committed to R2.
 *
 * It is deliberately a *report*, not a write proxy. The client keeps its own R2 credentials and its
 * own conditional PUT; the Vault only learns that the write happened, after checking it really did.
 */
export function createMutationIngress(
  env: MutationIngressEnv,
  journal: MutationJournal,
  recorder: MutationRecorder = createMutationRecorder({ journal }),
): MutationIngressService {
  const verifier = createR2MutationVerifier(env.MINERAL);
  return {
    async record(event) {
      return recordVerifiedMutationOrThrow({ recorder, verifier, journal }, event);
    },
  };
}

/**
 * `POST /internal/mutations`.
 *
 * Responses are chosen so the client always knows whether a retry is safe:
 *
 * - `202` accepted or duplicate — the fact is durable. A retry with the same id is a no-op.
 * - `409` the reported revision is not what R2 holds. Retrying the *report* will not help.
 * - `503` the journal could not commit, so the report **must** be retried; nothing is half-recorded.
 * - `204` a remote apply: bytes someone else already wrote are not a new fact.
 */
export async function handleMutationIngressRequest(
  request: Request,
  env: MutationIngressEnv,
  ingress: MutationIngressService,
): Promise<Response> {
  const json = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });

  // Without a configured secret the route stays closed; an unauthenticated mutation ingress would
  // let any caller invent facts about the vault.
  if (!env.MUTATION_INGRESS_TOKEN) return json(503, { error: "ingress_disabled" });
  const authorization = request.headers.get("Authorization");
  if (authorization !== `Bearer ${env.MUTATION_INGRESS_TOKEN}`) return json(401, { error: "unauthorized" });

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_MUTATION_INGRESS_BYTES) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_MUTATION_INGRESS_BYTES) return json(413, { error: "too_large" });

  const origin: MutationWriteOrigin = request.headers.get("X-Mineral-Mutation-Origin") === "remote-apply" ? "remote-apply" : "local-write";
  if (isRemoteApply({ origin })) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const event = parseIngressBody(raw);
  if (!event) return json(400, { error: "invalid_request" });
  try {
    const result = await ingress.record(event);
    return json(202, { status: result.status, seq: result.seq, mutationId: event.id });
  } catch (error) {
    if (error instanceof MutationIngressError) return json(error.status, { error: error.reason, mutationId: event.id });
    console.error(`mutation ingress failed id=${event.id} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    return json(503, { error: "journal_unavailable", mutationId: event.id });
  }
}
