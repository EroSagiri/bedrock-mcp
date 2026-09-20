import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createVaultService, VaultIndex } from "@mineral/vault";
import type { Env } from "./types";
import { handleFetch } from "./http";
import { registerMineralMcp } from "./mcp/register";
export { VaultIndex };

type DeploymentEnv = Omit<Env, "vault"> & {
  MINERAL: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<MineralMCP>;
  VAULT_INDEX: DurableObjectNamespace<VaultIndex>;
};

export class MineralMCP extends McpAgent<DeploymentEnv> {
  server = new McpServer({ name: "Mineral MCP", version: "1.0.0" });

  async init() {
    const vault = createVaultService(this.env);
    await registerMineralMcp({ env: { vault, STATIC_ACCESS_SECRET: this.env.STATIC_ACCESS_SECRET, PUBLIC_BASE_URL: this.env.PUBLIC_BASE_URL }, server: this.server });
  }
}

export default {
  async fetch(req: Request, env: DeploymentEnv, ctx: ExecutionContext) {
    const vault = createVaultService(env);
    return handleFetch(req, { vault, STATIC_ACCESS_SECRET: env.STATIC_ACCESS_SECRET, PUBLIC_BASE_URL: env.PUBLIC_BASE_URL }, ctx, MineralMCP.serve("/mcp"));
  },
  async scheduled(_controller: ScheduledController, env: DeploymentEnv, ctx: ExecutionContext) {
    ctx.waitUntil(createVaultService(env).index.refresh());
  },
};
