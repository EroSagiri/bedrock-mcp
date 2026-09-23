#!/usr/bin/env node
/**
 * Drives the deployed revision audit to completion and reports what the live index holds.
 *
 * A run is bounded: it walks at most AUDIT_PAGE_LIMIT pages and clears at most AUDIT_DRAIN_PER_PAGE of
 * the dirty set per page, so a first-time backfill needs several runs. It stops when the audit has
 * walked the whole vault and nothing is left owed.
 *
 * Usage: node scripts/backfill-live-index.mjs <mcpUrl> [maxRuns]
 */
const [mcpUrl, maxRunsArg] = process.argv.slice(2);
if (!mcpUrl) {
  console.error("usage: backfill-live-index.mjs <mcpUrl> [maxRuns]");
  process.exit(2);
}
const maxRuns = Number(maxRunsArg) || 40;
const target = new URL(mcpUrl);
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

/** This host resets new TLS handshakes intermittently, so every call retries. */
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

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  return { isError: result?.isError ?? false, text: (result?.content ?? []).map(part => part.text ?? "").join("\n") };
}

console.log(`endpoint=${target.origin}/mcp/<redacted>`);
await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "backfill", version: "1.0.0" } });

for (let run = 1; run <= maxRuns; run++) {
  await callTool("vault_index_refresh");
  const stats = JSON.parse((await callTool("vault_stats")).text);
  const pending = stats.pending ?? {};
  console.log(`run ${run}: documents=${stats.documents} stale=${stats.staleDocuments} owed=${(pending.upserts ?? 0) + (pending.removes ?? 0)}`);
  if (stats.staleDocuments === 0 && (pending.upserts ?? 0) + (pending.removes ?? 0) === 0 && stats.documents > 0) {
    console.log(`PASS  live index complete: ${stats.documents} documents, nothing owed`);
    process.exit(0);
  }
}

console.log(`stopped after ${maxRuns} runs; the index is still catching up`);
process.exit(1);
