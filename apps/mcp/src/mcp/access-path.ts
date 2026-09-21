const MCP_PATH_PREFIX = "/mcp/";
const MIN_SECRET_LENGTH = 32;
const SECRET_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Validates the opaque, fixed MCP endpoint path supplied as a Worker secret.
 * A query parameter is deliberately not accepted as authentication material.
 */
export function parseMcpAccessPath(value: string | undefined): string | null {
  if (!value?.startsWith(MCP_PATH_PREFIX)) return null;
  const secret = value.slice(MCP_PATH_PREFIX.length);
  if (secret.length < MIN_SECRET_LENGTH || !SECRET_SEGMENT.test(secret)) return null;
  return value;
}

export async function matchesMcpAccessPath(requestPath: string, accessPath: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [requestDigest, accessDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(requestPath)),
    crypto.subtle.digest("SHA-256", encoder.encode(accessPath)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(requestDigest, accessDigest);
}
