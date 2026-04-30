import type { Env } from "./types";
import { ensureUtf8ContentType, guessContentType } from "./storage/content";

type ServeMcp = {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(
    NULL_BODY_STATUSES.has(res.status) ? null : res.body,
    { status: res.status, statusText: res.statusText, headers }
  );
}

export async function serveStatic(req: Request, env: Env, pathname: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice("/static/".length));
  } catch {
    return new Response("Bad static path", { status: 400 });
  }
  if (!key || key.includes("..")) {
    return new Response("Bad static path", { status: 400 });
  }

  const obj = await env.BEDROCK.get(key);
  if (!obj?.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Content-Type", ensureUtf8ContentType(headers.get("Content-Type") ?? guessContentType(key)));

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { headers });
}

export async function handleFetch(req: Request, env: Env, ctx: ExecutionContext, mcp: ServeMcp): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const url = new URL(req.url);
  if (url.pathname === "/mcp") {
    const res = await mcp.fetch(req, env, ctx);
    return withCors(res);
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/static/")) {
    return withCors(await serveStatic(req, env, url.pathname));
  }
  return withCors(new Response("OK"));
}
