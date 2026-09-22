import { describe, it, expect } from "vitest";
import { handleFetch } from "../apps/mcp/src/http";
import type { Env } from "../apps/mcp/src/types";
import { matchesMcpAccessPath, parseMcpAccessPath } from "../apps/mcp/src/mcp/access-path";
import worker from "../apps/mcp/src/entrypoint";
import type { VaultRpc } from "@mineral/core/vault-rpc";

const env = {} as Env;
const ctx = {} as ExecutionContext;
const mcp = {
	async handler(_request: Request) {
		return new Response("unused");
	},
};
const accessPath = "/mcp/this-is-a-fixed-test-access-path-123456";
const mcpRoute = {
	matchesPath: (path: string) => matchesMcpAccessPath(path, accessPath),
	handler: (request: Request) => mcp.handler(request),
};
const vault = {} as VaultRpc & Pick<Fetcher, "fetch" | "connect">;

describe("Mineral MCP worker", () => {
	it("does not expose the removed web console", async () => {
		const response = await handleFetch(new Request("http://example.com"), env, ctx, mcpRoute);
		expect(response.status).toBe(404);
	});

	it("does not expose the removed REST API", async () => {
		const response = await handleFetch(new Request("http://example.com/api/documents"), env, ctx, mcpRoute);
		expect(response.status).toBe(404);
	});

	it("keeps the static attachment route", async () => {
		const response = await handleFetch(new Request("http://example.com/static/image.png"), env, ctx, mcpRoute);
		expect(response.status).toBe(401);
	});

	it("forwards only the fixed MCP access path", async () => {
		const response = await handleFetch(new Request(`http://example.com${accessPath}`), env, ctx, mcpRoute);
		expect(response.status).toBe(200);
	});

	it("does not expose the conventional MCP path", async () => {
		const response = await handleFetch(new Request("http://example.com/mcp"), env, ctx, mcpRoute);
		expect(response.status).toBe(404);
	});

	it("requires a long opaque MCP access path", () => {
		expect(parseMcpAccessPath(accessPath)).toBe(accessPath);
		expect(parseMcpAccessPath("/mcp/short")).toBeNull();
		expect(parseMcpAccessPath("/mcp/contains/a/slash-and-a-secret-1234567890123456")).toBeNull();
	});

	it("serves a stateless initialize without creating an MCP session header", async () => {
		const response = await worker.fetch(new Request(`http://example.com${accessPath}`, {
			method: "POST",
			headers: { Host: "example.com", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
			}),
	}), { VAULT: vault, MCP_ACCESS_PATH: accessPath, PUBLIC_BASE_URL: "https://example.com" }, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("mcp-session-id")).toBeNull();
	});
});
