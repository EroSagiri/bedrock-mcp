import { describe, it, expect } from "vitest";
import { handleFetch } from "../apps/mcp/src/http";
import type { Env } from "../apps/mcp/src/types";

const env = {} as Env;
const ctx = {} as ExecutionContext;
const mcp = {
	fetch: async () => new Response("unused"),
};

describe("Mineral MCP worker", () => {
	it("does not expose the removed web console", async () => {
		const response = await handleFetch(new Request("http://example.com"), env, ctx, mcp);
		expect(response.status).toBe(404);
	});

	it("does not expose the removed REST API", async () => {
		const response = await handleFetch(new Request("http://example.com/api/documents"), env, ctx, mcp);
		expect(response.status).toBe(404);
	});

	it("keeps the static attachment route", async () => {
		const response = await handleFetch(new Request("http://example.com/static/image.png"), env, ctx, mcp);
		expect(response.status).toBe(401);
	});
});
