import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Bedrock MCP worker", () => {
	it("redirects the root path to the web app (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("http://example.com/app");
	});

	it("serves the React app shell (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/app");
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(await response.text()).toContain("Bedrock Vault");
	});

	it("requires authentication for web APIs", async () => {
		const response = await SELF.fetch("https://example.com/api/documents");
		expect(response.status).toBe(401);
	});
});
