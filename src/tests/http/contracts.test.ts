import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestHttp } from "../fixtures/TestHttp";

const context = new TestHttp();
beforeAll(() => context.start());
afterAll(() => context.stop());

describe("HTTP contract", () => {
	test("health is public and production docs are absent", async () => {
		const health = await context.request("/health", { credential: null });
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			healthy: true,
			postgresql: true,
			redis: true,
		});
		for (const path of ["/openapi", "/swagger", "/licenses/id"]) {
			const response = await context.request(path);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
		}
	});
	test("all administrative routes require authorization", async () => {
		for (const path of [
			"/licenses",
			"/users",
			"/items",
			"/api-keys",
			"/webhooks",
			"/settings",
			"/metrics",
		]) {
			const response = await context.request(path, { credential: null });
			expect(response.status).toBe(401);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("x-request-id")).toBeTruthy();
		}
	});
	test("unknown and mistyped fields are rejected without echoing secrets", async () => {
		for (const body of [
			{ license: "SENSITIVE", extra: 1 },
			{ license: 42 },
			{ license: "SENSITIVE", usage: { requests: "1" } },
		]) {
			const response = await context.request("/validate", {
				method: "POST",
				body,
				credential: null,
			});
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("SENSITIVE");
		}
	});
	test("validation denials have exactly the two public fields", async () => {
		const response = await context.request("/validate", {
			method: "POST",
			body: { license: "unknown" },
			credential: null,
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(Object.keys(result).sort()).toEqual(["code", "reason"]);
		expect(result.code).toBe("LICENSE_INVALID");
	});
	test("secret issuance replay cannot disclose plaintext twice", async () => {
		const options = {
			method: "POST",
			body: {},
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
		};
		const created = await context.request("/licenses", options);
		expect(created.status).toBe(200);
		const result = await created.json();
		expect(result.credential).toBeString();
		expect(result.data.enabled).toBe(false);
		const replay = await context.request("/licenses", options);
		expect(replay.status).toBe(409);
		expect(await replay.text()).not.toContain(result.credential);
		const enabled = await context.request("/licenses/enable", {
			method: "POST",
			body: { ids: [result.data.id] },
		});
		expect(enabled.status).toBe(200);
		const self = await context.request("/licenses/self", {
			credential: result.credential,
		});
		expect(self.status).toBe(200);
		expect(Object.keys((await self.json()).data)).not.toContain("notes");
		expect(
			(await context.request("/licenses", { credential: result.credential }))
				.status,
		).toBe(403);
	});
	test("all-family API keys remain excluded from root routes", async () => {
		const response = await context.request("/api-keys", {
			method: "POST",
			body: {
				name: "all families",
				scopes: ["licenses:*", "users:*", "items:*", "webhooks:*"],
			},
			headers: { "Idempotency-Key": Bun.randomUUIDv7() },
		});
		expect(response.status).toBe(200);
		const issued = await response.json();
		expect(
			(
				await context.request("/api-keys/enable", {
					method: "POST",
					body: { ids: [issued.data.id] },
				})
			).status,
		).toBe(200);
		for (const path of ["/api-keys", "/settings", "/metrics"])
			expect(
				(await context.request(path, { credential: issued.credential })).status,
			).toBe(403);
		expect(
			(await context.request("/users", { credential: issued.credential }))
				.status,
		).toBe(200);
	});
	test("CORS changes take effect immediately and only validate allows origins", async () => {
		expect(
			(
				await context.request("/settings", {
					method: "PATCH",
					body: { changes: { corsOrigins: ["https://client.example"] } },
				})
			).status,
		).toBe(200);
		const headers = { Origin: "https://client.example" };
		const preflight = await context.request("/validate", {
			method: "OPTIONS",
			headers,
			credential: null,
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(
			"https://client.example",
		);
		expect(
			(await context.request("/users", { headers })).headers.get(
				"access-control-allow-origin",
			),
		).toBeNull();
		await context.request("/settings", {
			method: "PATCH",
			body: { changes: { corsOrigins: [] } },
		});
		expect(
			(
				await context.request("/validate", {
					method: "OPTIONS",
					headers,
					credential: null,
				})
			).headers.get("access-control-allow-origin"),
		).toBeNull();
	});
	test("media and body limits are enforced", async () => {
		const plain = await fetch(new URL("/validate", context.app.server?.url), {
			method: "POST",
			body: "{}",
		});
		expect(plain.status).toBe(415);
		const oversized = await context.request("/validate", {
			method: "POST",
			body: { license: "x".repeat(1048576) },
		});
		expect(oversized.status).toBe(413);
	});
});
