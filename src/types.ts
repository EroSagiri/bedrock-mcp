export type Env = {
  BEDROCK: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<import("./index").BedrockMCP>;
  VAULT_INDEX: DurableObjectNamespace<import("./vault-index").VaultIndex>;
  ADMIN_PASSWORD: string;
  STATIC_ACCESS_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  DAILY_NOTES_DIR?: string;
};
