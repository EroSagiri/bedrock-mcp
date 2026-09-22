import { isRemoteGeneration, type RemoteGeneration } from "./sync-change.js";
import { isRemoteChangeChannel } from "./channel.js";

/**
 * The complete v1 WebSocket vocabulary. It is intentionally tiny and closed: a socket may only ever
 * say "here is the current generation" or "the generation advanced".
 *
 * There is no `delete`, no path, no plan, no document, and no credential in this protocol. A client
 * must therefore never be able to translate a Gateway frame into a sync operation; it can only
 * learn that remote state *may* have changed.
 */
export const SUBSCRIBE_MESSAGE_TYPES = ["current-generation", "remote-dirty"] as const;
export type SubscribeMessageType = (typeof SUBSCRIBE_MESSAGE_TYPES)[number];

export type CurrentGenerationMessage = { type: "current-generation"; generation: RemoteGeneration };
export type RemoteDirtyMessage = { type: "remote-dirty"; generation: RemoteGeneration };
export type SubscribeMessage = CurrentGenerationMessage | RemoteDirtyMessage;

const types = new Set<string>(SUBSCRIBE_MESSAGE_TYPES);
const keys = new Set(["type", "generation"]);

function parseJson(payload: string | ArrayBuffer | Uint8Array): unknown {
  if (typeof payload === "string") { try { return JSON.parse(payload); } catch { return undefined; } }
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return undefined; }
}

/**
 * Runtime validator for inbound frames. `JSON.parse` output is never trusted directly: an unknown
 * type, an unexpected extra field, a numeric generation, a negative or non-canonical generation,
 * and plain junk all resolve to `undefined`, and the caller keeps its cursor untouched.
 *
 * Unknown fields are rejected rather than ignored on purpose. A frame carrying something like a
 * path is not a slightly-newer version of this protocol; it is a frame this client must not act on,
 * and dropping it loudly is what keeps "Gateway event ≠ Sync operation" true.
 */
export function parseSubscribeMessage(payload: string | ArrayBuffer | Uint8Array): SubscribeMessage | undefined {
  const value = parseJson(payload);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !keys.has(key))) return undefined;
  if (typeof candidate.type !== "string" || !types.has(candidate.type)) return undefined;
  if (!isRemoteGeneration(candidate.generation)) return undefined;
  return candidate.type === "current-generation"
    ? { type: "current-generation", generation: candidate.generation }
    : { type: "remote-dirty", generation: candidate.generation };
}

/** Kept for symmetry with channel validation in diagnostics and tests. */
export function isSubscribeChannel(value: unknown): boolean {
  return isRemoteChangeChannel(value);
}
