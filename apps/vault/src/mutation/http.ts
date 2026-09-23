import { createMutationRecorder, type MutationRecorder } from "./recorder";
import type { MutationJournal } from "./store";
import type { MutationEvent } from "./types";
import { MAX_MUTATION_INGRESS_BYTES, MutationIngressError, isRemoteApply, normalizeEtag, parseIngressBody, recordVerifiedMutationOrThrow, type MutationWriteOrigin } from "./ingress";

export { MutationIngressError } from "./ingress";

export type MutationIngressService = {
  record(event: MutationEvent): Promise<{ status: "accepted" | "duplicate"; seq: number }>;
};

/**
 * An ingress response plus what it means for the consumers.
 *
 * `recorded` is the whole reason this is not just a `Response`: a report that created a fact still has
 * to reach the gateway and the index, and the caller that holds `waitUntil` is the entrypoint, not this
 * module. A rejected or ignored report records nothing and therefore owes nothing.
 */
export type MutationIngressOutcome = {
  response: Response;
  recorded: boolean;
  mutationId?: string;
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
 *
 * The caller is expected to drain the journal's consumers afterwards when `recorded` is true. Without
 * that, a reported fact waits for the next cron tick — up to two hours — which would make the
 * gateway's low-latency wake-up a lie for exactly the writers that use this route.
 */
export async function handleMutationIngressRequest(
  request: Request,
  env: MutationIngressEnv,
  ingress: MutationIngressService,
): Promise<MutationIngressOutcome> {
  const json = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });

  // Without a configured secret the route stays closed; an unauthenticated mutation ingress would
  // let any caller invent facts about the vault.
  if (!env.MUTATION_INGRESS_TOKEN) return { response: json(503, { error: "ingress_disabled" }), recorded: false };
  const authorization = request.headers.get("Authorization");
  if (authorization !== `Bearer ${env.MUTATION_INGRESS_TOKEN}`) return { response: json(401, { error: "unauthorized" }), recorded: false };

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_MUTATION_INGRESS_BYTES) return { response: json(413, { error: "too_large" }), recorded: false };
  const raw = await request.text();
  if (raw.length > MAX_MUTATION_INGRESS_BYTES) return { response: json(413, { error: "too_large" }), recorded: false };

  const origin: MutationWriteOrigin = request.headers.get("X-Mineral-Mutation-Origin") === "remote-apply" ? "remote-apply" : "local-write";
  if (isRemoteApply({ origin })) return { response: new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }), recorded: false };

  const event = parseIngressBody(raw);
  if (!event) return { response: json(400, { error: "invalid_request" }), recorded: false };
  try {
    const result = await ingress.record(event);
    return { response: json(202, { status: result.status, seq: result.seq, mutationId: event.id }), recorded: true, mutationId: event.id };
  } catch (error) {
    if (error instanceof MutationIngressError) return { response: json(error.status, { error: error.reason, mutationId: event.id }), recorded: false };
    console.error(`mutation ingress failed id=${event.id} error=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    return { response: json(503, { error: "journal_unavailable", mutationId: event.id }), recorded: false };
  }
}

/**
 * `GET /internal/journal` — aggregate journal state, for an operator.
 *
 * Read-only, token-gated, and deliberately aggregate: it answers "did the facts arrive, and did they
 * leave?" without exposing a single path. The mutation route is the write surface; this one only
 * counts, so it can be called while diagnosing without touching the vault's contents.
 */
export async function handleJournalStateRequest(
  request: Request,
  env: MutationIngressEnv,
  state: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  if (!env.MUTATION_INGRESS_TOKEN) return Response.json({ error: "ingress_disabled" }, { status: 503, headers });
  if (request.headers.get("Authorization") !== `Bearer ${env.MUTATION_INGRESS_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  return Response.json(await state(), { headers });
}
