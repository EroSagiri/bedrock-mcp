import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./types";
import { handleFetch } from "./http";
import { registerBedrockMcp } from "./mcp/register";
export { VaultIndex } from "./vault-index";

export class BedrockMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Bedrock MCP", version: "1.0.0" });

  async init() {
    await registerBedrockMcp({ env: this.env, server: this.server });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handleFetch(req, env, ctx, BedrockMCP.serve("/mcp"));
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName("vault"));
    ctx.waitUntil(stub.fetch("https://vault-index/refresh", { method: "POST", body: "{}" }));
  },
};
