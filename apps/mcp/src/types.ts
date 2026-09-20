import type { VaultService } from "@mineral/vault";

export type Env = {
  vault: VaultService;
  STATIC_ACCESS_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};
