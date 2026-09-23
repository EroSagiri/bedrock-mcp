import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveToolConfig } from "../apps/mcp/src/mcp/compat";

/**
 * `registerToolCompat` accepts two forms of its third argument, and getting this wrong is not visible
 * until a client calls the tool: a config misfiled as a shape produces `expected a Zod schema` at
 * registration and nothing else. It happened once, so the distinction is pinned here.
 */
describe("telling a tool config from a bare input shape", () => {
  it("accepts a config whose only key is inputSchema", () => {
    const config = resolveToolConfig("vault_embedding_probe", { inputSchema: { model: z.string().optional() } });
    expect(Object.keys(config.inputSchema)).toEqual(["model"]);
    expect(config.annotations?.title).toBe("Probe the embedding model");
    expect(config.annotations?.readOnlyHint).toBe(true);
  });

  it("still accepts the shorthand shape", () => {
    const config = resolveToolConfig("vault_list_documents", { prefix: z.string().optional() });
    expect(Object.keys(config.inputSchema)).toEqual(["prefix"]);
    // An unknown tool falls back to a write-classified generic entry rather than an undefined one.
    expect(resolveToolConfig("some_new_tool", { inputSchema: {} })._meta).toMatchObject({ category: "vault", risk: "write" });
  });

  it("treats a schema in the inputSchema slot as a shape, as the shorthand always did", () => {
    const config = resolveToolConfig("some_new_tool", { inputSchema: z.object({ model: z.string() }) } as never);
    expect(Object.keys(config.inputSchema)).toEqual(["inputSchema"]);
  });

  it("lets an explicit annotation win over the risk default", () => {
    const config = resolveToolConfig("vault_index_refresh", { inputSchema: {}, annotations: { idempotentHint: true } });
    // The default for a write tool is not idempotent; the caller's claim is kept, and the rest is filled in.
    expect(config.annotations?.idempotentHint).toBe(true);
    expect(config.annotations?.destructiveHint).toBe(false);
    expect(config.annotations?.openWorldHint).toBe(false);
  });
});
