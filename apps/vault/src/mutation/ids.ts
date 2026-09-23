import type { MutationSource } from "./types";

/**
 * Mutation identity.
 *
 * The id is the layer's whole idempotency story: a client may retry a report whose response was
 * lost, and the journal must return the original record instead of inserting a second one. Nothing
 * here is derived from time or from content, so no two writers can collide by accident.
 */
export const MUTATION_ID_PREFIX = "mut_";

export function createMutationId(): string {
  return `${MUTATION_ID_PREFIX}${crypto.randomUUID()}`;
}

/** Accepts both the generated form and an opaque caller-supplied key, bounded like the event. */
export function isMutationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\0]/.test(value);
}

/**
 * Logs never carry a raw path. The digest is a short, non-reversible fingerprint that still lets an
 * operator correlate two log lines about the same document.
 */
export async function pathDigest(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  let binary = "";
  for (const byte of new Uint8Array(digest).slice(0, 8)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type MutationLogFields = {
  id?: string;
  seq?: number;
  source?: MutationSource;
  op?: string;
  pathDigest?: string;
  action?: string;
  notBefore?: number;
  gatewayGeneration?: string;
  attempts?: number;
  count?: number;
  /** A published/removal outcome, already reduced to one word. */
  status?: string;
  /** How many chunks one vector publish covered. */
  chunks?: number;
  /** A classified failure, already shortened; never a body, a token, or a raw path. */
  error?: string;
};

/** One structured line per fact. Values are scalars; no bodies, no raw paths, no credentials. */
export function mutationLog(event: string, fields: MutationLogFields = {}): void {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  console.log(parts.length ? `${event} ${parts.join(" ")}` : event);
}
