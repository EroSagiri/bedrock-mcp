import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./types";
import { handleFetch } from "./http";
import { registerMineralMcp } from "./mcp/register";
import { createVaultClient } from "./vault-client";
import { matchesMcpAccessPath, parseMcpAccessPath } from "./mcp/access-path";

type VaultBinding = import("@mineral/core/vault-rpc").VaultRpc & Pick<Fetcher, "fetch" | "connect">;

type DeploymentEnv = Omit<Env, "vault"> & {
  VAULT: VaultBinding;
};

async function createMineralMcpServer(env: Env): Promise<McpServer> {
  const server = new McpServer({ name: "Mineral MCP", version: "1.0.0" });
  await registerMineralMcp({ env, server });
  return server;
}

function mcpHostname(publicBaseUrl: string | undefined): string | null {
  if (!publicBaseUrl) return null;
  try {
    const url = new URL(publicBaseUrl);
    return url.protocol === "https:" && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: DeploymentEnv, ctx: ExecutionContext) {
    const accessPath = parseMcpAccessPath(env.MCP_ACCESS_PATH);
    const hostname = mcpHostname(env.PUBLIC_BASE_URL);
    const vault = createVaultClient(env.VAULT);
    const appEnv: Env = { ...env, vault };
    const mcp = accessPath && hostname
      ? createMcpHandler(() => createMineralMcpServer(appEnv), {
          route: accessPath,
          corsOptions: false,
          allowedHostnames: [hostname],
          allowedOriginHostnames: [hostname],
        })
      : null;

    return handleFetch(req, appEnv, ctx, {
      matchesPath: path => accessPath && hostname ? matchesMcpAccessPath(path, accessPath) : Promise.resolve(false),
      handler: request => mcp
        ? mcp(request, env, ctx)
        : Promise.resolve(new Response("Not found", { status: 404 })),
    });
  },
};
