#!/usr/bin/env node
/**
 * Prints the deployed MCP surface as markdown, so `docs/mcp-surface.md` can be diffed against reality.
 *
 * The surface is the product's contract, and it is the one thing documentation cannot check by reading the
 * source: what a client actually receives is the deployment's `tools/list`, `prompts/list` and
 * `resources/list`, after the registration seam in `apps/mcp/src/mcp/compat.ts` has had its say. So the
 * doc is written by hand for the *reasoning* and verified against this for the *facts*.
 *
 * The URL is read from `.env`; see `scripts/mcp-client.mjs` for why it is never an argument.
 *
 * Usage: node scripts/dump-mcp-surface.mjs [tools|prompts|resources|all]
 */
import { connect } from "./mcp-client.mjs";

const what = process.argv[2] ?? "all";
const mcp = await connect();
console.log(`<!-- endpoint=${mcp.safeEndpoint} server=${mcp.serverInfo} -->`);

const describe = value => {
  if (value.enum) return value.enum.join("\\|");
  if (value.type === "array") {
    const items = value.items?.enum ? value.items.enum.join("\\|") : value.items?.type ?? "?";
    return `array[${items}]`;
  }
  return value.type ?? "?";
};

if (what === "tools" || what === "all") {
  const tools = await mcp.listTools();
  console.log(`\n### tools (${tools.length})\n`);
  console.log("| tool | parameters | read/destructive | description |");
  console.log("| --- | --- | --- | --- |");
  for (const tool of tools) {
    const required = new Set(tool.inputSchema?.required ?? []);
    const parameters = Object.entries(tool.inputSchema?.properties ?? {})
      .map(([name, value]) => `${name}${required.has(name) ? "*" : ""}:${describe(value)}`)
      .join(", ") || "—";
    const kind = tool.annotations?.destructiveHint ? "destructive" : tool.annotations?.readOnlyHint ? "read" : "write";
    console.log(`| \`${tool.name}\` | ${parameters} | ${kind} | ${(tool.description ?? "").replace(/\|/g, "\\|")} |`);
  }
}

if (what === "prompts" || what === "all") {
  const prompts = (await mcp.request("prompts/list", {}))?.prompts ?? [];
  console.log(`\n### prompts (${prompts.length})\n`);
  for (const item of prompts) console.log(`- \`${item.name}\` — ${item.description ?? ""}`);
}

if (what === "resources" || what === "all") {
  const resources = (await mcp.request("resources/list", {}))?.resources ?? [];
  const templates = (await mcp.request("resources/templates/list", {}))?.resourceTemplates ?? [];
  console.log(`\n### resources (${resources.length} fixed, ${templates.length} templates)\n`);
  for (const item of resources) console.log(`- \`${item.uri}\` — ${item.description ?? ""}`);
  for (const item of templates) console.log(`- \`${item.uriTemplate}\` — ${item.description ?? ""}`);
}

process.exit(0);
