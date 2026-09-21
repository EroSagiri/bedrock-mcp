import type { VaultClient } from "./vault-client";

export type Env = {
  vault: VaultClient;
  STATIC_ACCESS_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MCP_ACCESS_PATH?: string;
};
