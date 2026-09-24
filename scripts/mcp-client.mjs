#!/usr/bin/env node
/**
 * A minimal MCP client for the deployed Mineral server, shared by the operator scripts.
 *
 * The access path in the URL *is* the credential: there is no Authorization header on this route. So the
 * URL is read from `.env` rather than taken as an argument, and only its shape is ever printed — a secret
 * on a command line lands in shell history and in the process list, and one that gets logged has to be
 * rotated.
 */
import { readFile } from "node:fs/promises";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

/** Reads `MINERAL_MCP_URL` from `.env`, or fails with something actionable. */
export async function mcpTarget() {
  const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
  const url = env.MINERAL_MCP_URL;
  if (!url) {
    console.error(".env does not define MINERAL_MCP_URL");
    process.exit(2);
  }
  const target = new URL(url);
  return { target, safeEndpoint: `${target.origin}/mcp/<redacted ${target.pathname.split("/").pop().length} chars>` };
}

function requestOnce(target, body, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        // The server may answer as JSON or as an SSE stream; both are asked for.
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(payload),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        sessionId: response.headers["mcp-session-id"],
        contentType: response.headers["content-type"] ?? "",
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

/** Accepts either a JSON body or an SSE stream, and returns the JSON-RPC message. */
function decode(response) {
  const text = response.text.trim();
  if (!text) return undefined;
  if (response.contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
    return data ? JSON.parse(data) : undefined;
  }
  return JSON.parse(text);
}

/**
 * Opens a session and returns the tools this deployment actually exposes.
 *
 * Every call retries: this host resets new TLS handshakes intermittently, and a backfill that dies on a
 * transient reset would leave the audit half-driven.
 */
export async function connect({ attempts = 5, retryDelayMs = 1500 } = {}) {
  const { target, safeEndpoint } = await mcpTarget();
  let sessionId;
  let nextId = 1;

  async function request(body) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await requestOnce(target, body, sessionId);
        if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 200)}`);
        sessionId ??= response.sessionId ?? undefined;
        return decode(response);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    throw lastError;
  }

  async function call(method, params) {
    const message = await request({ jsonrpc: "2.0", id: nextId++, method, params });
    if (message?.error) throw new Error(`${method} → ${JSON.stringify(message.error)}`);
    return message?.result;
  }

  const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mineral-operator", version: "1.0.0" } });
  return {
    safeEndpoint,
    serverInfo: `${initialized?.serverInfo?.name ?? "?"} ${initialized?.serverInfo?.version ?? ""}`,
    /** Any JSON-RPC method, for the parts of the surface this client does not wrap. */
    request: call,
    /** The tool definitions the deployment publishes, which is what a client caches. */
    async listTools() {
      return (await call("tools/list", {}))?.tools ?? [];
    },
    async callTool(name, args = {}) {
      const result = await call("tools/call", { name, arguments: args });
      return { isError: result?.isError ?? false, text: (result?.content ?? []).map(part => part.text ?? "").join("\n"), raw: result };
    },
  };
}
