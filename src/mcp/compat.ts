import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
  type ResourceMetadata,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerToolCompat<Args extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  inputSchema: Args,
  cb: ToolCallback<Args>
): RegisteredTool {
  return server.registerTool(name, { inputSchema }, cb);
}

export function registerResourceCompat(
  server: McpServer,
  name: string,
  uri: string,
  config: ResourceMetadata,
  readCallback: ReadResourceCallback
): RegisteredResource;
export function registerResourceCompat(
  server: McpServer,
  name: string,
  template: ResourceTemplate,
  readCallback: ReadResourceTemplateCallback
): RegisteredResourceTemplate;
export function registerResourceCompat(
  server: McpServer,
  name: string,
  uriOrTemplate: string | ResourceTemplate,
  configOrReadCallback: ResourceMetadata | ReadResourceTemplateCallback,
  maybeReadCallback?: ReadResourceCallback
): RegisteredResource | RegisteredResourceTemplate {
  if (typeof uriOrTemplate === "string") {
    return server.registerResource(
      name,
      uriOrTemplate,
      configOrReadCallback as ResourceMetadata,
      maybeReadCallback as ReadResourceCallback
    );
  }
  return server.registerResource(
    name,
    uriOrTemplate,
    {},
    configOrReadCallback as ReadResourceTemplateCallback
  );
}
