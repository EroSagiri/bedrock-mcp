import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultIndex } from "@mineral/vault";
import type { Env } from "./types";
import { handleFetch } from "./http";
import { registerMineralMcp } from "./mcp/register";
import { createVaultClient } from "./vault-client";
export { VaultIndex };

type VaultBinding = import("@mineral/core/vault-rpc").VaultRpc & Pick<Fetcher, "fetch" | "connect">;

type DeploymentEnv = Omit<Env, "vault"> & {
  // VaultIndex is retained as an external binding during the ownership-transfer
  // rollout; the source implementation remains exported until Phase 4D.
  MINERAL: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<MineralMCP>;
  VAULT_INDEX: DurableObjectNamespace;
  VAULT: VaultBinding;
};

export class MineralMCP extends McpAgent<DeploymentEnv> {
  server = new McpServer({ name: "Mineral MCP", version: "1.0.0" });

  async init() {
    const vault = createVaultClient(this.env.VAULT);
    await registerMineralMcp({ env: { vault, STATIC_ACCESS_SECRET: this.env.STATIC_ACCESS_SECRET, PUBLIC_BASE_URL: this.env.PUBLIC_BASE_URL }, server: this.server });
  }
}

export default {
  async fetch(req: Request, env: DeploymentEnv, ctx: ExecutionContext) {
    const vault = createVaultClient(env.VAULT);
    return handleFetch(req, { ...env, vault }, ctx, MineralMCP.serve("/mcp"));
  },
};
