import { verifyGatewayWebSocketTicket } from "@mineral/sync-core/gateway-protocol";

const encoder = new TextEncoder();

async function constantTimeEquals(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

/** Long-lived control-plane credential, carried as `Authorization: Bearer …`. */
export async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match || !expectedToken) return false;
  return constantTimeEquals(match[1], expectedToken);
}

/**
 * Authentication for the WebSocket route.
 *
 * Obsidian runs on desktop and Android WebView, and `new WebSocket(url)` can attach neither custom
 * headers nor a subprotocol-safe credential on both platforms. A long-lived bearer token must
 * therefore never be placed in a URL. The client first exchanges its bearer token for a short-lived,
 * channel-scoped ticket over ordinary HTTP, and presents that ticket here.
 *
 * A bearer token is still accepted when a client can send one, so this route stays compatible with
 * non-browser callers and with the existing HTTP contract.
 */
export async function isSubscribeAuthorized(request: Request, channel: string, expectedToken: string, now: number): Promise<boolean> {
  if (await isAuthorized(request, expectedToken)) return true;
  const ticket = new URL(request.url).searchParams.get("ticket") ?? undefined;
  return verifyGatewayWebSocketTicket({ ticket, channel, secret: expectedToken, now });
}
