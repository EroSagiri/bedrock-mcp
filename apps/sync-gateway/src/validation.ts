import type { MarkRemoteDirtyRequest, RemoteChangeHint } from "@mineral/core/sync-change";
import { isRemoteChangeChannel } from "./channel";

const MAX_HINT_BYTES = 8 * 1024;
const keys = new Set(["source", "kind", "writerId", "pathHash"]);
const sources = new Set(["obsidian", "vault", "unknown"]);
const kinds = new Set(["upsert", "delete", "unknown"]);

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
  for (const key of ["writerId", "pathHash"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 128)) return null;
  }
  return { channel, ...(input as RemoteChangeHint) };
}

export function validRpcRequest(request: MarkRemoteDirtyRequest): boolean {
  if (!request || !isRemoteChangeChannel(request.channel)) return false;
  const { channel, ...hint } = request;
  return Object.keys(hint).every(key => keys.has(key)) &&
    (hint.source === undefined || sources.has(hint.source)) &&
    (hint.kind === undefined || kinds.has(hint.kind)) &&
    (hint.writerId === undefined || typeof hint.writerId === "string" && hint.writerId.length <= 128) &&
    (hint.pathHash === undefined || typeof hint.pathHash === "string" && hint.pathHash.length <= 128);
}
