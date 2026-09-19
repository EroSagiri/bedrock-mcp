import { registerBedrockResources } from "./resources";
import { registerBedrockPrompts } from "./prompts";
import { registerDocumentTools } from "./tools/documents";
import { registerFileTools } from "./tools/files";
import { registerGraphTools } from "./tools/graph";
import { registerLinkTools } from "./tools/links";
import { registerSearchTools } from "./tools/search";
import { registerVaultTools } from "./tools/vault";
import { registerTagTools } from "./tools/tags";
import { type McpRegistrationContext } from "./shared";

export async function registerBedrockMcp(ctx: McpRegistrationContext): Promise<void> {
  registerVaultTools(ctx);
  registerTagTools(ctx);
  registerDocumentTools(ctx);
  registerFileTools(ctx);
  registerSearchTools(ctx);
  registerLinkTools(ctx);
  registerGraphTools(ctx);
  registerBedrockResources(ctx);
  registerBedrockPrompts(ctx);
}
