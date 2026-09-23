#!/usr/bin/env node
/**
 * Minimal MCP client over streamable HTTP, for exercising the deployed Mineral MCP server.
 *
 * The access path in the URL *is* the credential (there is no Authorization header on this route), so
 * the URL is read from `.env` and only ever sent to the server — never printed, never put on a command
 * line where it would land in shell history or a process list.
 *
 * Usage:
 *   node scripts/mcp-call.mjs list
 *   node scripts/mcp-call.mjs call <tool> '<json args>'
 */
import { readFile } from "node:fs/promises";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
const mcpUrl = env.MINERAL_MCP_URL;
if (!mcpUrl) {
  console.error(".env does not define MINERAL_MCP_URL");
  process.exit(2);
}
const target = new URL(mcpUrl);
// Only the scheme/host and the path's shape are ever echoed; the secret segment is redacted.
const safeEndpoint = `${target.origin}/mcp/<redacted ${target.pathname.split("/").pop().length} chars>`;

function requestOnce(body, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
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
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function request(body, sessionId, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce(body, sessionId);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
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

let nextId = 1;
const call = async (method, params, sessionId) => {
  const response = await request({ jsonrpc: "2.0", id: nextId++, method, params }, sessionId);
  if (response.status >= 400) throw new Error(`${method} → HTTP ${response.status}: ${response.text.slice(0, 200)}`);
  const message = decode(response);
  if (message?.error) throw new Error(`${method} → ${JSON.stringify(message.error)}`);
  return { message, sessionId: response.sessionId };
};

const [command, toolName, rawArgs] = process.argv.slice(2);
console.log(`endpoint=${safeEndpoint}`);

const initialized = await call("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "mineral-mcp-call", version: "1.0.0" },
});
const sessionId = initialized.sessionId;
console.log(`initialize → ${initialized.message?.result?.serverInfo?.name ?? "?"} ${initialized.message?.result?.serverInfo?.version ?? ""}`);

if (command === "list") {
  const listed = await call("tools/list", {}, sessionId);
  const tools = listed.message?.result?.tools ?? [];
  console.log(`tools: ${tools.length}`);
  for (const tool of tools) console.log(`  ${tool.name}`);
  process.exit(0);
}

if (command === "call") {
  if (!toolName) {
    console.error("usage: mcp-call.mjs call <tool> '<json args>'");
    process.exit(2);
  }
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const started = Date.now();
  const called = await call("tools/call", { name: toolName, arguments: args }, sessionId);
  const elapsed = Date.now() - started;
  const result = called.message?.result;
  const text = (result?.content ?? []).map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
  console.log(`tools/call ${toolName} → isError=${result?.isError ?? false} ${elapsed}ms`);
  console.log(text);
  process.exit(result?.isError ? 1 : 0);
}

console.error("usage: mcp-call.mjs list | call <tool> '<json args>'");
process.exit(2);
