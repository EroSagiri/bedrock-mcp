export type Env = {
  MINERAL: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<import("./index").MineralMCP>;
  VAULT_INDEX: DurableObjectNamespace<import("./vault-index").VaultIndex>;
  STATIC_ACCESS_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};
