import { describe, expect, it, mock } from "bun:test";
import type { RedisClient } from "bun";
import type { ServerConfig } from "../config";
import type { Database } from "../db";
import { DomainError } from "../domain/errors";
import { createServer } from "../index";

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		databaseUrl: "postgresql://localhost/keyzori_test",
		redisUrl: "redis://localhost:6379",
		adminPass: "admin-secret",
		host: "127.0.0.1",
		port: 3000,
		trustProxyHeaders: false,
		trustedProxyCidrs: [],
		trustedProxyHeader: "x-forwarded-for",
		openapiEnabled: true,
		rateLimitPerMinute: 60,
		licenseRateLimitPerMinute: 30,
		rateLimitPerIpPerMinute: 6_000,
		maxRequestBodyBytes: 65_536,
		stripe: null,
		eventRetentionDays: 30,
		...overrides,
	};
}

function dependencies() {
	const redis = {
		ping: mock(async () => "PONG"),
		send: mock(async () => [1, 0]),
	} as unknown as RedisClient;
	const database = {
		execute: mock(async () => []),
	} as unknown as Database;
	return { redis, database };
}

function jsonRequest(
	path: string,
	body: object,
	headers?: RequestInit["headers"],
) {
	return new Request(`http://localhost:3000${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("Keyzori server", () => {
	it("exposes liveness and dependency readiness with security headers", async () => {
		const { redis, database } = dependencies();
		const app = createServer(redis, serverConfig(), database);

		const health = await app.handle(
			new Request("http://localhost:3000/health"),
		);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ status: "ok" });
		expect(health.headers.get("x-content-type-options")).toBe("nosniff");
		expect(health.headers.get("x-frame-options")).toBe("DENY");

		const ready = await app.handle(new Request("http://localhost:3000/ready"));
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ready" });
		expect(database.execute).toHaveBeenCalledTimes(1);
		expect(redis.ping).toHaveBeenCalledTimes(1);
	});

	it("reports dependency unavailability", async () => {
		const { redis, database } = dependencies();
		redis.ping = mock(async () => {
			throw new Error("Redis unavailable");
		});
		const app = createServer(redis, serverConfig(), database);
		const response = await app.handle(
			new Request("http://localhost:3000/ready"),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "unavailable" });
	});

	it("publishes only the canonical API in OpenAPI", async () => {
		const { redis, database } = dependencies();
		const app = createServer(redis, serverConfig(), database);
		const docs = await app.handle(new Request("http://localhost:3000/docs"));
		expect(docs.status).toBe(200);
		expect(await docs.text()).toContain('id="api-reference"');

		const specification = await app.handle(
			new Request("http://localhost:3000/docs/openapi.json"),
		);
		expect(specification.status).toBe(200);
		const document = (await specification.json()) as {
			info: { title: string; description?: string };
			paths: Record<
				string,
				Record<
					string,
					{ operationId?: string; security?: Record<string, string[]>[] }
				>
			>;
			components: { securitySchemes: Record<string, unknown> };
		};

		expect(document.info.title).toBe("Keyzori API");
		expect(document.info.description).toContain("`KEYZORI_STRIPE_SECRET_KEY`");
		expect(document.paths["/v1/activate"]?.post?.operationId).toBe(
			"activateLicense",
		);
		expect(document.paths["/v1/heartbeat"]?.post?.operationId).toBe(
			"heartbeatLicense",
		);
		expect(document.paths["/v1/usage"]?.post?.operationId).toBe(
			"consumeLicenseUsage",
		);
		expect(document.paths["/v1/deactivate"]?.post?.operationId).toBe(
			"deactivateLicense",
		);
		expect(document.paths["/admin/customers"]).toBeDefined();
		expect(document.paths["/admin/licenses"]).toBeDefined();
		for (const [path, operations] of Object.entries(document.paths)) {
			if (!path.startsWith("/admin/")) continue;
			for (const [method, operation] of Object.entries(operations)) {
				if (method === "parameters") continue;
				expect(operation.security).toEqual([{ AdminKey: [] }]);
			}
		}
		expect(document.paths["/"]).toBeUndefined();
		expect(document.paths["/v1/handshake"]).toBeUndefined();
		expect(document.paths["/admin/users"]).toBeUndefined();
		expect(document.paths["/admin/keys"]).toBeUndefined();
		expect(document.paths["/webhooks/stripe"]).toBeUndefined();
		expect(document.components.securitySchemes.AdminKey).toBeDefined();
	});

	it("enforces the coarse request ceiling before runtime handlers", async () => {
		const { redis, database } = dependencies();
		redis.send = mock(async () => [0, 11]);
		const app = createServer(redis, serverConfig(), database);
		const response = await app.handle(
			jsonRequest("/v1/activate", {
				licenseKey: "lic_rate_limited",
				deviceId: "desktop-1",
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("11");
		expect(await response.json()).toEqual({
			error: "Too Many Requests",
			code: "RATE_LIMITED",
		});
	});

	it("returns safe JSON for unexpected boundary failures", async () => {
		const { redis, database } = dependencies();
		redis.send = mock(async () => {
			throw new Error("sensitive Redis detail");
		});
		const app = createServer(redis, serverConfig(), database);
		const response = await app.handle(
			jsonRequest("/v1/activate", {
				licenseKey: "lic_never_echo_this",
				deviceId: "desktop-1",
			}),
		);

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toEqual({
			error: "Internal Server Error",
			code: "INTERNAL_ERROR",
		});
		expect(JSON.stringify(body)).not.toContain("sensitive Redis detail");
		expect(JSON.stringify(body)).not.toContain("lic_never_echo_this");
	});

	it("maps uncaught domain errors at the server boundary", async () => {
		const { redis, database } = dependencies();
		const app = createServer(redis, serverConfig(), database).get(
			"/__test_domain_error",
			() => {
				throw new DomainError("Safe domain failure", 409);
			},
		);
		const response = await app.handle(
			new Request("http://localhost:3000/__test_domain_error"),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Safe domain failure",
			code: "INVALID_REQUEST",
		});
	});

	it("requires admin authentication and strict runtime payloads", async () => {
		const { redis, database } = dependencies();
		const app = createServer(redis, serverConfig(), database);
		const unauthorized = await app.handle(
			new Request("http://localhost:3000/admin/licenses"),
		);
		expect(unauthorized.status).toBe(401);

		const invalid = await app.handle(
			jsonRequest("/v1/activate", { licenseKey: "lic_missing_device" }),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toHaveProperty("code", "INVALID_REQUEST");

		const removed = await app.handle(
			jsonRequest("/v1/handshake", { apiKey: "sk_old", hwid: "old" }),
		);
		expect(removed.status).toBe(404);
	});

	it("does not expose optional Stripe routes without configuration", async () => {
		const { redis, database } = dependencies();
		const app = createServer(redis, serverConfig({ stripe: null }), database);

		const stripeWebhook = await app.handle(
			new Request("http://localhost:3000/webhooks/stripe", {
				method: "POST",
				headers: { "stripe-signature": "test" },
				body: "{}",
			}),
		);
		expect(stripeWebhook.status).toBe(404);

		const stripeAdmin = await app.handle(
			new Request("http://localhost:3000/admin/licenses/license-1/stripe", {
				headers: { "x-admin-key": "admin-secret" },
			}),
		);
		expect(stripeAdmin.status).toBe(404);
	});
});
