import { mutationLog, pathDigest } from "./ids";
import type { MutationRecorder, RecordedMutation } from "./recorder";
import type { MutationJournal } from "./store";
import { isMutationEvent, isMutationSource, type MutationEvent, type MutationSource } from "./types";

/** The maximum ingress body. A mutation is a fact, not a payload. */
export const MAX_MUTATION_INGRESS_BYTES = 8 * 1024;

/** Only a client that actually wrote to R2 may report a mutation; nothing self-declared is trusted. */
export const INGRESS_SOURCES: readonly MutationSource[] = ["obsidian", "web"];

/** The authoritative R2 state a report is checked against. */
export type MutationVerifier = {
  /** The current object revision, or `null` when the object does not exist. */
  observe(path: string): Promise<{ etag: string; size: number } | null>;
};

export type IngressOutcome =
  | { status: "accepted"; record: RecordedMutation }
  | { status: "duplicate"; record: RecordedMutation }
  | { status: "rejected"; reason: "state-mismatch" | "invalid" | "source-not-allowed" };

/**
 * A report that does not describe the authoritative R2 state.
 *
 * It is an error rather than an outcome because it must not be answered with "accepted": the HTTP
 * layer maps it to 409, and retrying the *report* will not help.
 */
export class MutationIngressError extends Error {
  readonly status = 409;
  constructor(readonly reason: "state-mismatch") {
    super(reason);
  }
}

export type MutationIngressDependencies = {
  recorder: MutationRecorder;
  verifier: MutationVerifier;
  journal: MutationJournal;
};

/** A write that only applied bytes someone else already wrote to R2 is not a new fact. */
export type MutationWriteOrigin = "local-write" | "remote-apply" | "unknown";

/**
 * Parses a JSON mutation report without trusting any of it.
 *
 * `id` and `committedAt` are bounded here; `source` is restricted to writers that wrote to R2
 * themselves. An MCP-originated report is not accepted on this path, because the Vault itself
 * records those writes and a second report would be a forgery vector, not a convenience.
 */
export function parseIngressBody(raw: string): MutationEvent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!isMutationSource(body.source) || !INGRESS_SOURCES.includes(body.source)) return null;
  if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 128) return null;
  if (typeof body.committedAt !== "number" || !Number.isFinite(body.committedAt)) return null;
  const candidate = { ...body, committedAt: Math.floor(body.committedAt) };
  return isMutationEvent(candidate) ? candidate : null;
}

/**
 * A remote apply is **not** a mutation.
 *
 * When device A writes R2 and device B downloads the result, B has changed only local files. If B
 * reported that download, every client would answer every other client forever. This predicate is
 * the single guard that keeps an apply from becoming a fact.
 */
export function isRemoteApply(context: { origin: MutationWriteOrigin }): boolean {
  return context.origin === "remote-apply";
}

/**
 * R2 reports an ETag with surrounding quotes; a client may report either form. Comparing the
 * unquoted values is the only way the check is about the revision and not about formatting.
 */
export function normalizeEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

/**
 * Records a mutation reported by a client that wrote R2 directly.
 *
 * Idempotency is checked **before** verification: a retry whose response was lost must succeed even
 * though the object has since moved on, otherwise the retry could never be answered. A first-time
 * report is verified against the authoritative R2 state so a wrong or malicious ETag cannot pollute
 * the journal, the gateway, or the index.
 */
export async function recordVerifiedMutation(
  dependencies: MutationIngressDependencies,
  event: MutationEvent,
): Promise<IngressOutcome> {
  const digest = await pathDigest(event.path);
  if (await dependencies.journal.findByMutationId(event.id)) {
    const replay = await dependencies.recorder.record(event);
    mutationLog("mutation duplicate ignored", { id: event.id, seq: replay.seq, source: event.source, op: event.op, pathDigest: digest });
    return { status: "duplicate", record: replay };
  }
  const observed = await dependencies.verifier.observe(event.path);
  const reported = event.op === "put" ? event.etag : event.op === "rename" ? event.etag : undefined;
  const matches = reported === undefined
    ? observed === null
    : observed !== null && normalizeEtag(observed.etag) === normalizeEtag(reported);
  if (!matches) {
    mutationLog("mutation ingress rejected", { id: event.id, source: event.source, op: event.op, pathDigest: digest });
    return { status: "rejected", reason: "state-mismatch" };
  }
  const record = await dependencies.recorder.record(event);
  mutationLog("mutation ingress accepted", { id: event.id, seq: record.seq, source: event.source, op: event.op, pathDigest: digest });
  return { status: record.inserted ? "accepted" : "duplicate", record };
}

/** The throwing form, for callers that need a status code rather than an outcome. */
export async function recordVerifiedMutationOrThrow(
  dependencies: MutationIngressDependencies,
  event: MutationEvent,
): Promise<{ status: "accepted" | "duplicate"; seq: number }> {
  const outcome = await recordVerifiedMutation(dependencies, event);
  if (outcome.status === "rejected") throw new MutationIngressError("state-mismatch");
  return { status: outcome.status, seq: outcome.record.seq };
}
