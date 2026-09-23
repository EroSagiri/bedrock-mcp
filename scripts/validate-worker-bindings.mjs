#!/usr/bin/env node
/**
 * Static check of the cross-Worker wiring.
 *
 * A service binding is only as good as the entrypoint it names. The Vault's publisher speaks RPC, and
 * RPC methods live on a *named* WorkerEntrypoint: binding the Gateway's default export reaches its
 * `fetch` handler, where `markRemoteDirty` does not exist. Nothing catches that at build time — it
 * surfaces at runtime as `The RPC receiver does not implement the method "markRemoteDirty"`, once per
 * mutation, forever, with the facts stacking up as pending.
 *
 * Runs as part of `npm run build`, because a deployment that reaches production with a binding like
 * that is exactly the failure this exists to prevent.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

/** wrangler.jsonc is JSON with comments; these files only use whole-line comments. */
async function config(relativePath) {
  const text = await readFile(join(root, relativePath), "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

const gateway = await config("apps/sync-gateway/wrangler.jsonc");
const vault = await config("apps/vault/wrangler.jsonc");
const mcp = await config("apps/mcp/wrangler.jsonc");

const exportedAs = (document, name) => document.exports?.[name]?.type;

// The Vault publishes to the Gateway over RPC, so the binding must name the RPC entrypoint.
const gatewayBinding = (vault.services ?? []).find(service => service.binding === "SYNC_GATEWAY");
check(gatewayBinding?.service === "mineral-sync-gateway", "vault: SYNC_GATEWAY must target mineral-sync-gateway");
check(gatewayBinding?.entrypoint === "SyncGatewayEntrypoint", "vault: SYNC_GATEWAY must name the entrypoint SyncGatewayEntrypoint (an RPC method does not exist on the fetch handler)");
check(exportedAs(gateway, "SyncGatewayEntrypoint") === "worker", "gateway: SyncGatewayEntrypoint must be exported as a worker entrypoint");
check(typeof gateway.main === "string", "gateway: must declare main");

// The Gateway is the only client-facing control plane, so a reported mutation arrives there and is
// relayed to its owner. The Vault keeps the R2 verification and the journal.
const relayBinding = (gateway.services ?? []).find(service => service.binding === "VAULT");
check(relayBinding?.service === "mineral-vault", "gateway: VAULT must target mineral-vault");
check(relayBinding?.entrypoint === undefined, "gateway: VAULT must bind the Vault's default entrypoint (where recordReportedMutation lives)");
// The Gateway holds no R2 credential: it must not gain one just to be a relay.
check((gateway.r2_buckets ?? []).length === 0, "gateway: must not hold an R2 binding (the Vault is the only thing that verifies a report)");

// MCP reaches the Vault over RPC, and the Vault's RPC surface is its default export.
const vaultBinding = (mcp.services ?? []).find(service => service.binding === "VAULT");
check(vaultBinding?.service === "mineral-vault", "mcp: VAULT must target mineral-vault");
check(vaultBinding?.entrypoint === undefined, "mcp: VAULT must bind the Vault's default entrypoint (its RPC surface)");

// Durable Object bindings must name classes the same Worker actually exports.
for (const [document, bindingName, className, label] of [
  [gateway, "REMOTE_CHANGE_HUB", "RemoteChangeHub", "gateway"],
  [vault, "VAULT_INDEX", "VaultIndex", "vault"],
]) {
  const binding = (document.durable_objects?.bindings ?? []).find(entry => entry.name === bindingName);
  check(binding?.class_name === className, `${label}: ${bindingName} must bind ${className}`);
  check(exportedAs(document, className) === "durable-object", `${label}: ${className} must be exported as a durable-object`);
  check(exportedAs(document, className) !== undefined, `${label}: ${className} is not exported`);
}

// The publisher derives the gateway channel from these, so a missing value disables the broadcast.
for (const key of ["MINERAL_R2_ENDPOINT", "MINERAL_BUCKET", "MINERAL_REMOTE_PREFIX"]) {
  check(typeof vault.vars?.[key] === "string", `vault: vars.${key} must be set (the publisher derives its channel from them)`);
}check(
  typeof vault.vars?.MINERAL_R2_ENDPOINT === "string" && /^https:\/\//i.test(vault.vars.MINERAL_R2_ENDPOINT) && !/example\.r2\.cloudflarestorage\.com$/i.test(new URL(vault.vars.MINERAL_R2_ENDPOINT).hostname),
  "vault: vars.MINERAL_R2_ENDPOINT must be the real R2 endpoint (a placeholder would derive a channel nobody subscribes to)",
);

// The Vault is the only Worker that embeds: the vector index is built from what it committed, so the
// AI binding belongs here. A deployment without it does not fail loudly — the probe answers
// "ai-binding-missing" and semantic search stays empty — which is why it is checked statically.
check(vault.ai?.binding === "AI", "vault: must declare the Workers AI binding as AI (the embedding probe and the vector index depend on it)");
check(!(mcp.ai ?? gateway.ai), "mcp/gateway: must not hold an AI binding (only the Vault embeds)");

if (failures.length > 0) {
  console.error("worker binding validation failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("worker binding validation: PASS");
