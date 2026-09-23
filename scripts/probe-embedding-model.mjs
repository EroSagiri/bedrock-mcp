#!/usr/bin/env node
/**
 * Asks the deployed Workers AI binding for the dimensions of the embedding model Vector v1 is frozen on.
 *
 * `wrangler vectorize create` takes dimensions once and cannot change them, and a mismatch between the
 * model's output width and the index's width fails every upsert at runtime. So the width is measured
 * before the index exists, not assumed from documentation.
 *
 * Usage: node scripts/probe-embedding-model.mjs <mcpUrl> [model]
 */
const [mcpUrl, modelArg] = process.argv.slice(2);
if (!mcpUrl) {
  console.error("usage: probe-embedding-model.mjs <mcpUrl> [model]");
  process.exit(2);
}
const model = modelArg ?? "@cf/qwen/qwen3-embedding-0.6b";
let session;
let nextId = 1;

async function rpcOnce(method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  session ??= response.headers.get("mcp-session-id") ?? undefined;
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("")
    : text;
  if (!payload) return undefined;
  const message = JSON.parse(payload);
  if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
  return message.result;
}

async function rpc(method, params) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await rpcOnce(method, params);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

console.log(`endpoint=${new URL(mcpUrl).origin}/mcp/<redacted>`);
console.log(`model=${model}`);
await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "embed-probe", version: "1.0.0" } });

const result = await rpc("tools/call", { name: "vault_embedding_probe", arguments: { model } });
const text = (result?.content ?? []).map(part => part.text ?? "").join("\n");
console.log(text);
process.exit(result?.isError ? 1 : 0);
