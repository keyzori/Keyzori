import { describe, expect, test } from "bun:test";
import { integrationAvailable, TestContext } from "../helpers/TestContext.ts";

describe.skipIf(!integrationAvailable)(
	"rate limits before request processing",
	() => {
		test.each([
			["malformed JSON", "/sessions", "{", 422],
			["invalid schema", "/sessions", "{}", 422],
			["unknown route", "/missing-route", "{}", 404],
		] as const)(
			"%s consumes the runtime rate budget",
			async (_, path, body, firstStatus) => {
				const ctx = await new TestContext({
					KEYZORI_RATE_LIMIT: "1",
					KEYZORI_TRUSTED_PROXIES: "127.0.0.1",
				}).start();
				try {
					const headers = {
						"Content-Type": "application/json",
						"X-Forwarded-For": `198.19.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`,
					};
					const first = await fetch(ctx.url + path, {
						method: "POST",
						headers,
						body,
					});
					expect(first.status).toBe(firstStatus);
					expect(first.headers.get("cache-control")).toBe("no-store");
					await first.arrayBuffer();
					const denied = await fetch(ctx.url + path, {
						method: "POST",
						headers,
						body,
					});
					expect(denied.status).toBe(429);
					expect((await denied.json()).error.code).toBe("RATE_LIMITED");
					const otherPath = await fetch(`${ctx.url}/usage`, {
						method: "POST",
						headers,
						body: "{}",
					});
					expect(otherPath.status).toBe(429);
					await otherPath.arrayBuffer();
					for (const route of ["/health", "/ready"])
						expect((await ctx.request(route)).status).toBe(200);
				} finally {
					await ctx.close();
				}
			},
		);
	},
);
