import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";
import { adminKey } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)("HTTP failure contracts", () => {
	let ctx: TestContext;
	beforeAll(async () => {
		ctx = await new TestContext().start();
	});
	afterAll(async () => {
		await ctx?.close();
	});
	test.each(["/admin/customers", "/admin/licenses", "/admin/activity"])(
		"missing %s resource route returns structured 404",
		async (route) => {
			const result = await ctx.request(`${route}/${crypto.randomUUID()}`);
			expect(result.status).toBe(404);
			expect(result.body.error.code).toBe("NOT_FOUND");
		},
	);
	test("malformed JSON, metadata arrays, and oversized metadata fail without storing data", async () => {
		const response = await fetch(`${ctx.url}/admin/customers`, {
			method: "POST",
			headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
			body: '{"email":',
		});
		expect(response.status).toBe(422);
		expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
		const before = await ctx.app.services.customers.list({});
		for (const [metadata, status] of [
			[[], 422],
			[{ x: "a".repeat(8193) }, 400],
		] as const) {
			const result = await ctx.request("/admin/customers", "POST", {
				email: "bad@example.com",
				name: "Bad",
				metadata,
			});
			expect(result.status).toBe(status);
		}
		expect(await ctx.app.services.customers.list({})).toEqual(before);
	});
	test("unexpected dependency errors hide internal messages and secrets", async () => {
		const failure = spyOn(ctx.app.services.customers, "list").mockRejectedValue(
			new Error("postgres://private:password@server lic_secret"),
		);
		const log = spyOn(ctx.app.services.logger, "error").mockImplementation(
			() => {},
		);
		try {
			const result = await ctx.request("/admin/customers");
			expect(result.status).toBe(503);
			expect(result.body.error.code).toBe("UNAVAILABLE");
			expect(JSON.stringify(result.body)).not.toMatch(
				/private|password|lic_secret/,
			);
			expect(log).toHaveBeenCalledWith(
				"request.dependency_or_internal_failure",
			);
		} finally {
			failure.mockRestore();
			log.mockRestore();
		}
	});
	test("readiness blocks administration while liveness remains available", async () => {
		ctx.app.state.ready = false;
		try {
			expect((await ctx.request("/health")).status).toBe(200);
			expect((await ctx.request("/ready")).status).toBe(503);
			expect((await ctx.request("/admin/customers")).body.error.code).toBe(
				"NOT_READY",
			);
		} finally {
			ctx.app.state.ready = true;
		}
	});
	test.each(["/sessions/heartbeat", "/sessions/deactivate", "/usage"])(
		"runtime route %s rejects malformed bearer headers",
		async (path) => {
			for (const headers of [
				{},
				{ Authorization: "Bearer invalid", "X-Device-Id": "device" },
			] as Record<string, string>[]) {
				const result = await ctx.request(
					path,
					"POST",
					path === "/usage"
						? { meter: "exports", eventId: "one", units: 1 }
						: {},
					headers,
				);
				expect(result.status).toBe(422);
				expect(result.body.error.code).toBe("VALIDATION_ERROR");
			}
		},
	);
	test("bound runtime requests reject changed devices without invalidating the genuine session", async () => {
		const license = await ctx.license();
		const session = await ctx.activate(license.key);
		const headers = {
			Authorization: `Bearer ${session.token}`,
			"X-Device-Id": "wrong-device",
		};
		const result = await ctx.request(
			"/sessions/heartbeat",
			"POST",
			{},
			headers,
		);
		expect(result.status).toBe(401);
		expect(result.body.error.code).toBe("SESSION_BINDING");
		headers["X-Device-Id"] = "test-device";
		expect(
			(await ctx.request("/sessions/heartbeat", "POST", {}, headers)).status,
		).toBe(200);
		expect(
			(await ctx.request("/sessions/deactivate", "POST", {}, headers)).status,
		).toBe(200);
		expect(
			(await ctx.request("/sessions/heartbeat", "POST", {}, headers)).body.error
				.code,
		).toBe("SESSION_INVALID");
	});
	test("activity rejects reversed dates consistently for list and statistics", async () => {
		const query = "?from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z";
		for (const route of ["/admin/activity", "/admin/activity/statistics"]) {
			const result = await ctx.request(route + query);
			expect(result.status).toBe(400);
			expect(result.body.error.code).toBe("INVALID_RANGE");
		}
	});
	test("public and successful authenticated responses disable caching", async () => {
		for (const route of ["/health", "/ready", "/admin/customers"]) {
			const response = await fetch(ctx.url + route, {
				headers: { "X-Admin-Key": adminKey },
			});
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});
	test("rate limiting returns 429 but leaves health checks available", async () => {
		const limited = await new TestContext({
			KEYZORI_RATE_LIMIT: "1",
			KEYZORI_TRUSTED_PROXIES: "127.0.0.1",
		}).start();
		try {
			const headers = {
				"X-Admin-Key": adminKey,
				"X-Forwarded-For": `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`,
			};
			expect(
				(await limited.request("/admin/customers", "GET", undefined, headers))
					.status,
			).toBe(200);
			const denied = await limited.request(
				"/admin/customers",
				"GET",
				undefined,
				headers,
			);
			expect(denied.status).toBe(429);
			expect(denied.body.error.code).toBe("RATE_LIMITED");
			expect((await limited.request("/health")).status).toBe(200);
			expect((await limited.request("/ready")).status).toBe(200);
		} finally {
			await limited.close();
		}
	});
});
