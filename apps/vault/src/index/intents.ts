import type { MutationEvent, MutationSource } from "../mutation/types";

/**
 * Index intents: the *materialised dirty set*, not an event history.
 *
 * A consumer of this module asks one question — "what index work is still owed for this path?" —
 * and the answer is always the current final action, never the sequence of things that happened.
 * That is the whole difference from the Mutation Journal, and it is why this must not be modelled as
 * a FIFO queue.
 */
export const INDEX_ACTIONS = ["upsert", "remove"] as const;
export type IndexAction = (typeof INDEX_ACTIONS)[number];

/** Human editing is bursty; machine writes have a completion boundary. */
export const OBSIDIAN_INDEX_DEBOUNCE_MS = 30_000;

export type IndexIntent = {
  path: string;
  action: IndexAction;
  /** Only meaningful for `upsert`: the revision this intent wants to see indexed. */
  targetEtag: string | null;
  source: MutationSource;
  notBefore: number;
  firstDirtyAt: number;
  updatedAt: number;
  attempts: number;
  lastError: string | null;
};

export type IndexIntentSpec = Pick<IndexIntent, "path" | "action" | "targetEtag" | "notBefore">;

/**
 * The debounce policy, expressed once so the ingress and the scheduler cannot disagree.
 *
 * Only human **editing** is bursty. A delete is an already-committed physical fact and takes effect
 * immediately, and an MCP write has a completion boundary, so neither pays a debounce.
 */
export function indexNotBefore(source: MutationSource, op: MutationEvent["op"], committedAt: number): number {
  return source === "obsidian" && op === "put" ? committedAt + OBSIDIAN_INDEX_DEBOUNCE_MS : committedAt;
}

/**
 * A mutation becomes one or two intents. `rename` is decomposed here rather than taught to the
 * gateway or the index worker, so the first version of both protocols stays small.
 */
export function indexIntentsFor(event: MutationEvent): IndexIntentSpec[] {
  const notBefore = indexNotBefore(event.source, event.op, event.committedAt);
  if (event.op === "put") return [{ path: event.path, action: "upsert", targetEtag: event.etag, notBefore }];
  if (event.op === "delete") return [{ path: event.path, action: "remove", targetEtag: null, notBefore }];
  return [
    { path: event.from, action: "remove", targetEtag: null, notBefore },
    { path: event.path, action: "upsert", targetEtag: event.etag ?? null, notBefore },
  ];
}

/**
 * Coalescing rule, applied to the row that is already dirty.
 *
 * The newest event always wins for `action` and `targetEtag`: `put → delete` ends as `remove`, and
 * `delete → put` ends as `upsert` of the newest revision. `notBefore` only ever moves forward, so a
 * debounce window that was already pushed out cannot be pulled back in by a later arrival.
 */
export function applyIntent(current: IndexIntent, spec: IndexIntentSpec, source: MutationSource, now: number): IndexIntent {
  const sameAction = current.action === spec.action;
  const sameTarget = current.action === "remove" || current.targetEtag === spec.targetEtag;
  const unchanged = sameAction && sameTarget && spec.notBefore <= current.notBefore;
  if (unchanged) return current;
  return {
    ...current,
    action: spec.action,
    targetEtag: spec.action === "remove" ? null : spec.targetEtag,
    source,
    notBefore: Math.max(current.notBefore, spec.notBefore),
    updatedAt: now,
  };
}
