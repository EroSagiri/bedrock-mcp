#!/usr/bin/env node
/**
 * The missing leg of the end-to-end check: does a fact that enters through the Mutation Ingress
 * actually reach the Sync Gateway without waiting for the cron?
 *
 * Read-mostly by design. It sends one report for a logical delete of a path that does not exist — a
 * shape the ingress accepts (the object is verifiably gone) and that writes nothing to R2 — then
 * watches the channel's generation. If the generation moves, the Vault's Sync Publisher did the
 * publishing, because in ingress mode the plugin no longer sends its own `/dirty`.
 *
 * Usage:
 *   node scripts/verify-mutation-ingress-publish.mjs <dataJsonPath> [timeoutSeconds]
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import https from "node:https";

const [dataPath, timeoutArg] = process.argv.slice(2);
if (!dataPath) {
  console.error("usage: verify-mutation-ingress-publish.mjs <data.json path> [timeoutSeconds]");
  process.exit(2);
}
const timeoutSeconds = Number(timeoutArg) || 60;

const settings = JSON.parse(await readFile(dataPath, "utf8"));
const required = ["endpoint", "bucket", "gatewayEndpoint", "gatewayToken", "mutationIngressEndpoint", "mutationIngressToken"];
const missing = required.filter(key => !settings[key]);
if (missing.length > 0) {
  console.error(`data.json is missing: ${missing.join(", ")}`);
  process.exit(2);
}
if (!settings.mutationIngressEnabled) {
  console.error("mutationIngressEnabled is not true — the plugin is still in legacy mode");
  process.exit(2);
}

// The channel is derived exactly as the plugin derives it, so this reads the same subscription.
const canonicalEndpoint = (value) => new URL(value).toString().replace(/\/$/, "");
const canonicalPrefix = (value) => {
  const raw = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return raw ? `${raw}/` : "";
};
const segment = (value) => `${value.length}:${value}`;
const input = ["v1", segment(canonicalEndpoint(settings.endpoint)), segment(settings.bucket), segment(canonicalPrefix(settings.remotePrefix))].join(":");
const channel = createHash("sha256").update(input).digest("base64url");

/**
 * `node:https` rather than `fetch`: this machine routes through a local proxy that resets undici's
 * TLS, and the plugin itself uses Obsidian's `requestUrl`, not undici. The connection is also
 * intermittently reset before the handshake completes, so a bounded retry is part of the helper
 * rather than something each call site has to remember.
 */
async function requestOnce(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method,
      agent: false,
      headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function request(url, options = {}, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

const generation = async () => {
  const response = await request(`${settings.gatewayEndpoint.replace(/\/+$/, "")}/v1/channels/${channel}`, {
    headers: { authorization: `Bearer ${settings.gatewayToken}` },
  });
  if (response.status !== 200) throw new Error(`gateway read failed: HTTP ${response.status}`);
  const parsed = JSON.parse(response.text);
  if (typeof parsed?.generation !== "string") throw new Error("gateway read returned no generation");
  return parsed.generation;
};

const before = await generation();
console.log(`channel=${channel.slice(0, 6)}…(${channel.length}) generation=${before}`);

const probeId = `mut_publish_probe_${Date.now().toString(36)}`;
const probePath = `.mineral-sync-test/publish-probe-${Date.now().toString(36)}.md`;
const report = await request(`${settings.mutationIngressEndpoint.replace(/\/+$/, "")}/internal/mutations`, {
  method: "POST",
  headers: { authorization: `Bearer ${settings.mutationIngressToken}`, "content-type": "application/json" },
  body: JSON.stringify({ id: probeId, source: "obsidian", op: "delete", path: probePath, committedAt: Date.now() }),
});
console.log(`ingress POST ${probePath} -> HTTP ${report.status} ${report.text}`);
if (report.status !== 202) {
  console.error("the ingress did not accept the report; nothing to observe");
  process.exit(1);
}

const deadline = Date.now() + timeoutSeconds * 1000;
let published;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  let current;
  try { current = await generation(); } catch (error) { console.log(`  read failed: ${error.message}`); continue; }
  if (current !== before) { published = current; break; }
}

if (!published) {
  console.error(`no generation change within ${timeoutSeconds}s — the fact is journalled but not published`);
  process.exit(1);
}
console.log(`generation ${before} -> ${published}`);
console.log("PASS  an ingress-reported fact reached the gateway without a cron tick");
