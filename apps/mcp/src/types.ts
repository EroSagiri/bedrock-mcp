import type { VaultService } from "@mineral/vault";

export type Env = {
  vault: VaultService;
  /** @deprecated Compatibility alias. New MCP code must use vault.documents. */
  MINERAL: VaultService["documents"];
  STATIC_ACCESS_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};
