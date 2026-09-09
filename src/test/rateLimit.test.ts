import { describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";
import type { LicenseService } from "../application/services/LicenseService";
import { ClientIpResolver } from "../controllers/clientIp";
import { licensePlugin } from "../controllers/license";
import {
	rateLimiter,
	RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";

const sessionToken = "11111111-1111-4111-8111-111111111111";

function post(path: string, body: object): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function sessionResult() {
	return {
		success: true as const,
		licenseType: "metered" as const,
		metadata: {},
		sessionToken,
		sessionTtlSeconds: 45,
	};
}

describe("rate limiting", () => {
	test("isolates activation principals and hashes all runtime secrets", async () => {
		const consumedKeys: string[] = [];
		const limiter = {
			consume: mock(async (key: string) => {
				consumedKeys.push(key);
				return { allowed: true, retryAfterSeconds: 0 };
			}),
		} as unknown as RedisSlidingWindowRateLimiter;
		const service = {
			activate: mock(async () => sessionResult()),
			heartbeat: mock(async () => sessionResult()),
			consume: mock(async () => ({
				success: true as const,
				meter: "builds",
				units: 1,
				eventId: "event-1",
				remaining: 4,
			})),
			deactivate: mock(async () => ({ success: true as const })),
		} as unknown as LicenseService;
		const app = new Elysia().use(
			licensePlugin(
				service,
				{ trustProxyHeaders: false, trustedProxyCidrs: [] },
				{ limiter, requestsPerMinute: 30 },
			),
		);

		for (const licenseKey of ["lic_first-secret", "lic_second-secret"]) {
			const response = await app.handle(
				post("/v1/activate", { licenseKey, deviceId: "shared-device" }),
			);
			expect(response.status).toBe(200);
		}
		for (const [path, body] of [
			["/v1/heartbeat", { sessionToken, deviceId: "shared-device" }],
			[
				"/v1/usage",
				{
					sessionToken,
					deviceId: "shared-device",
					meter: "builds",
					units: 1,
					eventId: "event-1",
				},
			],
			["/v1/deactivate", { sessionToken, deviceId: "shared-device" }],
		] as const) {
			const response = await app.handle(post(path, body));
			expect(response.status).toBe(200);
		}

		expect(consumedKeys).toHaveLength(5);
		expect(consumedKeys[0]).not.toBe(consumedKeys[1]);
		expect(consumedKeys[0]?.startsWith("ratelimit:license:activate:")).toBe(
			true,
		);
		expect(consumedKeys[1]?.startsWith("ratelimit:license:activate:")).toBe(
			true,
		);
		expect(consumedKeys[2]?.startsWith("ratelimit:license:heartbeat:")).toBe(
			true,
		);
		expect(consumedKeys[3]?.startsWith("ratelimit:license:usage:")).toBe(true);
		expect(consumedKeys[4]?.startsWith("ratelimit:license:deactivate:")).toBe(
			true,
		);
		for (const key of consumedKeys) {
			expect(key.startsWith("ratelimit:license:")).toBe(true);
			expect(key).not.toContain("lic_first-secret");
			expect(key).not.toContain("lic_second-secret");
			expect(key).not.toContain(sessionToken);
			expect(key).not.toContain("shared-device");
		}
	});

	test("usage bursts cannot exhaust heartbeat or deactivation budgets", async () => {
		const counts = new Map<string, number>();
		const limiter = {
			consume: mock(async (key: string, limit: number) => {
				const count = counts.get(key) ?? 0;
				if (count >= limit) {
					return { allowed: false, retryAfterSeconds: 60 };
				}
				counts.set(key, count + 1);
				return { allowed: true, retryAfterSeconds: 0 };
			}),
		} as unknown as RedisSlidingWindowRateLimiter;
		const service = {
			heartbeat: mock(async () => sessionResult()),
			consume: mock(
				async (
					_sessionToken: string,
					_deviceId: string,
					_ip: string,
					input: { meter: string; units: number; eventId: string },
				) => ({
					success: true as const,
					...input,
					remaining: 100,
				}),
			),
			deactivate: mock(async () => ({ success: true as const })),
		} as unknown as LicenseService;
		const app = new Elysia().use(
			licensePlugin(
				service,
				{ trustProxyHeaders: false, trustedProxyCidrs: [] },
				{ limiter, requestsPerMinute: 30 },
			),
		);

		for (let index = 0; index < 30; index++) {
			const response = await app.handle(
				post("/v1/usage", {
					sessionToken,
					deviceId: "shared-device",
					meter: "builds",
					units: 1,
					eventId: `event-${index}`,
				}),
			);
			expect(response.status).toBe(200);
		}

		const exhaustedUsage = await app.handle(
			post("/v1/usage", {
				sessionToken,
				deviceId: "shared-device",
				meter: "builds",
				units: 1,
				eventId: "event-30",
			}),
		);
		expect(exhaustedUsage.status).toBe(429);
		expect(
			await app.handle(
				post("/v1/heartbeat", { sessionToken, deviceId: "shared-device" }),
			),
		).toMatchObject({ status: 200 });
		expect(
			await app.handle(
				post("/v1/deactivate", { sessionToken, deviceId: "shared-device" }),
			),
		).toMatchObject({ status: 200 });
		expect(service.consume).toHaveBeenCalledTimes(30);
		expect(service.heartbeat).toHaveBeenCalledTimes(1);
		expect(service.deactivate).toHaveBeenCalledTimes(1);
	});

	test("returns the limiter's exact Retry-After on runtime routes", async () => {
		const limiter = {
			consume: mock(async () => ({
				allowed: false,
				retryAfterSeconds: 17,
			})),
		} as unknown as RedisSlidingWindowRateLimiter;
		const service = {
			activate: mock(async () => sessionResult()),
		} as unknown as LicenseService;
		const app = new Elysia().use(
			licensePlugin(
				service,
				{ trustProxyHeaders: false, trustedProxyCidrs: [] },
				{ limiter, requestsPerMinute: 30 },
			),
		);

		const response = await app.handle(
			post("/v1/activate", {
				licenseKey: "lic_rate_limited",
				deviceId: "desktop-1",
			}),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("17");
		expect(await response.json()).toEqual({
			error: "Too Many Requests",
			code: "RATE_LIMITED",
		});
		expect(service.activate).not.toHaveBeenCalled();
	});

	test("decodes Redis' exact Retry-After value", async () => {
		const redis = {
			send: mock(async () => [0, 17]),
		} as unknown as import("bun").RedisClient;
		const limiter = new RedisSlidingWindowRateLimiter(redis);
		expect(await limiter.consume("hashed-principal", 30)).toEqual({
			allowed: false,
			retryAfterSeconds: 17,
		});
	});

	test("enforces the coarse IP ceiling independently and skips readiness", async () => {
		const limiter = {
			consume: mock(async () => ({
				allowed: false,
				retryAfterSeconds: 9,
			})),
		} as unknown as RedisSlidingWindowRateLimiter;
		const resolver = new ClientIpResolver({
			trustProxyHeaders: false,
			trustedProxyCidrs: [],
		});
		const app = new Elysia()
			.use(rateLimiter(limiter, 6_000, resolver))
			.get("/limited", () => ({ success: true }))
			.get("/ready", () => ({ status: "ready" }));

		const response = await app.handle(new Request("http://localhost/limited"));
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("9");
		expect(await response.json()).toEqual({
			error: "Too Many Requests",
			code: "RATE_LIMITED",
		});
		expect(limiter.consume).toHaveBeenCalledWith(
			"ratelimit:ip:127.0.0.1",
			6_000,
		);

		limiter.consume = mock(async () => {
			throw new Error("readiness must not touch the limiter");
		});
		const ready = await app.handle(new Request("http://localhost/ready"));
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ready" });
	});
});
