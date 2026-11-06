import { expect, spyOn, test } from "bun:test";
import { createApp } from "../../app";
import { ServerServices } from "../../core/ServerServices";
import { Config } from "../../core/config/Config";
import { HttpError } from "../../core/http/HttpError";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import { settingsDefaults } from "../../plugins/settings/defaults";

function fixture(maxInFlight = 128, peerRequestsPerMinute = 600) {
	const services = new ServerServices(
		new Config({
			KZ_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/keyzori",
			KZ_REDIS_URL: "redis://127.0.0.1:1",
			KZ_MASTER_KEY: new KeyGenerator().master(),
			KZ_LOG_LEVEL: "error",
			KZ_MAX_IN_FLIGHT: String(maxInFlight),
			KZ_PEER_REQUESTS_PER_MINUTE: String(peerRequestsPerMinute),
		}),
	);
	const database = spyOn(services.database, "transaction").mockImplementation(
		async () => {
			throw new Error("Admission test must not reach the database");
		},
	);
	const redis = spyOn(services.redis, "send").mockResolvedValue([1, 60000]);
	const authenticate = spyOn(services.auth, "authenticate").mockImplementation(
		async () => {
			throw new HttpError("UNAUTHORIZED");
		},
	);
	const settings = spyOn(services.settings, "read").mockResolvedValue(
		settingsDefaults,
	);
	const ip = spyOn(services.ip, "resolve").mockResolvedValue("127.0.0.1");
	const app = createApp(
		services,
		services.tracker,
		services.logger,
		services.metrics,
	);
	return {
		services,
		app,
		database,
		redis,
		authenticate,
		settings,
		async close() {
			await app.server?.stop(true);
			services.activity.stop();
			services.redis.close();
			await services.database.close();
			for (const mock of [database, redis, authenticate, settings, ip])
				mock.mockRestore();
		},
	};
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 1000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

test("in-flight admission rejects before JSON parsing, authentication or database access and releases capacity", async () => {
	const context = fixture(1);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = spyOn(context.services.health, "status").mockImplementation(
		async () => {
			entered.resolve();
			await release.promise;
			return {
				healthy: true,
				postgresql: true,
				redis: true,
				checkedAt: new Date().toISOString(),
				ageMs: 0,
				version: "test",
			};
		},
	);
	context.app.listen({ hostname: "127.0.0.1", port: 0 });
	const first = fetch(new URL("/health", context.app.server?.url));
	try {
		await entered.promise;
		expect(context.services.tracker.active).toBe(1);
		const rejected = await fetch(
			new URL("/licenses", context.app.server?.url),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
				signal: AbortSignal.timeout(1000),
			},
		);
		expect(rejected.status).toBe(503);
		expect(await rejected.json()).toMatchObject({
			ok: false,
			error: { code: "SERVICE_UNAVAILABLE" },
		});
		expect(context.redis).toHaveBeenCalledTimes(1);
		expect(context.authenticate).not.toHaveBeenCalled();
		expect(context.settings).not.toHaveBeenCalled();
		expect(context.database).not.toHaveBeenCalled();
		await until(() => context.services.tracker.active === 1);
		release.resolve();
		expect((await first).status).toBe(200);
		await until(() => context.services.tracker.active === 0);
		const next = await fetch(new URL("/live", context.app.server?.url));
		expect(next.status).toBe(200);
		await until(() => context.services.tracker.active === 0);
	} finally {
		release.resolve();
		await first.catch(() => undefined);
		held.mockRestore();
		await context.close();
	}
});

test("unauthenticated failures exhaust peer admission before another parse or credential check", async () => {
	const context = fixture(128, 2);
	const peerKey = `kz:rate:${new SecretHasher().hash("peer:127.0.0.1")}`;
	let requests = 0;
	context.redis.mockImplementation(async (_command, args) => [
		args[2] === peerKey ? ++requests : 1,
		60000,
	]);
	context.app.listen({ hostname: "127.0.0.1", port: 0 });
	try {
		for (let request = 0; request < 2; request++) {
			const response = await fetch(
				new URL("/licenses", context.app.server?.url),
			);
			expect(response.status).toBe(401);
			await response.arrayBuffer();
		}
		const rejected = await fetch(
			new URL("/licenses", context.app.server?.url),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
			},
		);
		expect(rejected.status).toBe(429);
		expect(rejected.headers.get("retry-after")).toBe("60");
		expect(await rejected.json()).toMatchObject({
			error: { code: "RATE_LIMITED" },
		});
		expect(requests).toBe(3);
		expect(context.authenticate).toHaveBeenCalledTimes(2);
		expect(context.settings).toHaveBeenCalledTimes(2);
		expect(context.database).not.toHaveBeenCalled();
		await until(() => context.services.tracker.active === 0);
	} finally {
		await context.close();
	}
});

test("unavailable peer admission fails closed before parsing an unauthenticated request", async () => {
	const context = fixture();
	context.redis.mockRejectedValue(new Error("Unavailable fixture dependency"));
	context.app.listen({ hostname: "127.0.0.1", port: 0 });
	try {
		const response = await fetch(
			new URL("/licenses", context.app.server?.url),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
			},
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "SERVICE_UNAVAILABLE" },
		});
		expect(context.authenticate).not.toHaveBeenCalled();
		expect(context.settings).not.toHaveBeenCalled();
		expect(context.database).not.toHaveBeenCalled();
		await until(() => context.services.tracker.active === 0);
	} finally {
		await context.close();
	}
});

test("health shares a pending dependency probe beyond the cache interval and exposes its failure", async () => {
	const context = fixture();
	const pending = Promise.withResolvers<boolean>();
	const postgres = spyOn(context.services.database, "ping").mockImplementation(
		() => pending.promise,
	);
	const redis = spyOn(context.services.redis, "ping").mockResolvedValue(true);
	context.services.health.ready = true;
	try {
		const first = context.services.health.status();
		await Bun.sleep(1050);
		const second = context.services.health.status();
		const third = context.services.health.status();
		expect(postgres).toHaveBeenCalledTimes(1);
		expect(redis).toHaveBeenCalledTimes(1);
		pending.resolve(false);
		const results = await Promise.all([first, second, third]);
		for (const result of results) {
			expect(result.healthy).toBe(false);
			expect(result.postgresql).toBe(false);
			expect(result.redis).toBe(true);
			expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
			expect(result.ageMs).toBeGreaterThanOrEqual(0);
		}
		expect(new Set(results.map((result) => result.checkedAt)).size).toBe(1);
		expect((await context.services.health.status()).healthy).toBe(false);
		expect(postgres).toHaveBeenCalledTimes(1);
	} finally {
		pending.resolve(false);
		postgres.mockRestore();
		redis.mockRestore();
		await context.close();
	}
});
