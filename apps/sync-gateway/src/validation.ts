import type { MarkRemoteDirtyRequest, RemoteChange, RemoteChangeHint } from "@mineral/sync-core/sync-change";
import { isRemoteChangeChannel } from "./channel";

const MAX_HINT_BYTES = 8 * 1024;
const keys = new Set(["source", "kind", "writerId", "pathHash", "mutationId", "changes"]);
const sources = new Set(["obsidian", "vault", "unknown"]);
const kinds = new Set(["upsert", "delete", "unknown"]);
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.startsWith("/") && !value.includes("\0");
function validChange(value: unknown): value is RemoteChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  if (change.op === "put") return Object.keys(change).every(key => ["op", "path", "etag", "size", "modified"].includes(key)) && validPath(change.path) && (change.etag === undefined || typeof change.etag === "string") && (change.size === undefined || typeof change.size === "number" && Number.isFinite(change.size) && change.size >= 0) && (change.modified === undefined || typeof change.modified === "string");
  if (change.op === "delete") return Object.keys(change).every(key => key === "op" || key === "path") && validPath(change.path);
  return change.op === "rename" && Object.keys(change).every(key => ["op", "from", "to", "etag"].includes(key)) && validPath(change.from) && validPath(change.to) && (change.etag === undefined || typeof change.etag === "string");
}

export async function parseDirtyRequest(request: Request, channel: string): Promise<MarkRemoteDirtyRequest | null> {
  if (!isRemoteChangeChannel(channel)) return null;
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_HINT_BYTES)) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_HINT_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !keys.has(key))) return null;
  if (input.source !== undefined && (typeof input.source !== "string" || !sources.has(input.source))) return null;
  if (input.kind !== undefined && (typeof input.kind !== "string" || !kinds.has(input.kind))) return null;
  if (input.changes !== undefined && (!Array.isArray(input.changes) || input.changes.length > 128 || !input.changes.every(validChange))) return null;
  for (const key of ["writerId", "pathHash", "mutationId"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 128 || input[key].length === 0)) return null;
  }
  return { channel, ...(input as RemoteChangeHint), ...(input.changes ? { changes: input.changes as RemoteChange[] } : {}) };
}

export function validRpcRequest(request: MarkRemoteDirtyRequest): boolean {
  if (!request || !isRemoteChangeChannel(request.channel)) return false;
  const { channel, ...hint } = request;
  return Object.keys(hint).every(key => keys.has(key)) &&
    (hint.source === undefined || sources.has(hint.source)) &&
    (hint.kind === undefined || kinds.has(hint.kind)) &&
    (hint.writerId === undefined || typeof hint.writerId === "string" && hint.writerId.length <= 128) &&
    (hint.pathHash === undefined || typeof hint.pathHash === "string" && hint.pathHash.length <= 128) &&
    (hint.mutationId === undefined || typeof hint.mutationId === "string" && hint.mutationId.length > 0 && hint.mutationId.length <= 128) &&
    (hint.changes === undefined || Array.isArray(hint.changes) && hint.changes.length <= 128 && hint.changes.every(validChange));
}
