import { expect, spyOn, test } from "bun:test";
import { ServerLifecycle } from "../../core/ServerLifecycle";
import { Config } from "../../core/config/Config";
import {
	MigrationError,
	MigrationService,
} from "../../core/database/MigrationService";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import { HealthService } from "../../plugins/health/HealthService";
import { Metrics } from "../../core/observability/Metrics";
import { settingsDefaults } from "../../plugins/settings/defaults";

function fixture(
	graceMs = 500,
	totalMs = 1500,
	environment: Record<string, string> = {},
) {
	return new ServerLifecycle(
		new Config({
			KZ_DATABASE_URL: "postgresql://127.0.0.1:1/fixture",
			KZ_REDIS_URL: "redis://127.0.0.1:1",
			KZ_API_HOST: "127.0.0.1",
			KZ_MASTER_KEY: new KeyGenerator().master(),
			KZ_LOG_LEVEL: "error",
			...environment,
		}),
		{ graceMs, totalMs },
	);
}

test.each(["schema", "dependencies", "publication"])(
	"stop joins and fences bootstrap during %s",
	async (phase) => {
		const server = fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const barrier = async (at: string) => {
			if (at !== phase) return;
			entered.resolve();
			await release.promise;
		};
		const verify = spyOn(
			MigrationService.prototype,
			"verifyRuntime",
		).mockImplementation(async () => {
			await barrier("schema");
			return { migrations: 1, fingerprint: "fixture" };
		});
		const connect = spyOn(server.services.redis, "connect").mockImplementation(
			() => barrier("dependencies"),
		);
		const postgres = spyOn(server.services.database, "ping").mockResolvedValue(
			true,
		);
		const pong = spyOn(server.services.redis, "ping").mockResolvedValue(true);
		const publish = spyOn(
			server.services.activity,
			"publish",
		).mockImplementation(async () => {
			await barrier("publication");
			return 0;
		});
		const stopRedis = spyOn(server.services.redis, "close");
		const listen = spyOn(server.app, "listen").mockImplementation(() => {
			throw new Error("Unexpected listener");
		});
		const start = server.start();
		try {
			expect(server.start()).toBe(start);
			await entered.promise;
			const stop = server.stop();
			expect(server.stop()).toBe(stop);
			expect(server.services.tracker.draining).toBe(true);
			await Bun.sleep(5);
			expect(stopRedis).not.toHaveBeenCalled();
			release.resolve();
			await expect(start).rejects.toThrow("Startup interrupted");
			await stop;
			expect(listen).not.toHaveBeenCalled();
			expect(stopRedis).toHaveBeenCalledTimes(1);
			if (phase === "schema") expect(connect).not.toHaveBeenCalled();
			if (phase !== "publication") expect(postgres).not.toHaveBeenCalled();
			await expect(server.start()).rejects.toThrow("Startup interrupted");
		} finally {
			release.resolve();
			await Promise.allSettled([start, server.stop()]);
			for (const mock of [
				verify,
				connect,
				postgres,
				pong,
				publish,
				stopRedis,
				listen,
			])
				mock.mockRestore();
		}
	},
);

test("a startup error survives a cleanup fault and every final closer runs", async () => {
	const server = fixture();
	const failure = new MigrationError(
		"RUNTIME_ROLE_REQUIRED",
		"PRIVATE FIXTURE DETAIL",
	);
	const verify = spyOn(
		MigrationService.prototype,
		"verifyRuntime",
	).mockRejectedValue(failure);
	const close = spyOn(server.services.redis, "close").mockImplementation(() => {
		throw new Error("PRIVATE CLOSER DETAIL");
	});
	const postgres = spyOn(server.services.database, "close");
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await expect(server.start()).rejects.toBe(failure);
		await expect(server.stop()).rejects.toMatchObject({
			code: "SHUTDOWN_FAILED",
		});
		expect(postgres).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(log.mock.calls)).toContain("SHUTDOWN_FAILED");
		expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
	} finally {
		for (const mock of [verify, close, postgres, log]) mock.mockRestore();
		server.services.redis.close();
	}
});

test("a settlement rejection is not a clean drain, even when final closers succeed", async () => {
	const server = fixture();
	const drain = spyOn(server.services.dispatcher, "drain").mockRejectedValue(
		new Error("settlement unavailable"),
	);
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await expect(server.stop()).rejects.toMatchObject({
			code: "SHUTDOWN_FAILED",
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("DRAINED");
	} finally {
		drain.mockRestore();
		log.mockRestore();
	}
});

test("a disconnected HTTP handler settles before its database is closed", async () => {
	const server = fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const send = spyOn(server.services.redis, "send").mockResolvedValue([
		1, 60000,
	]);
	const status = spyOn(server.services.health, "status").mockImplementation(
		async () => {
			entered.resolve();
			await release.promise;
			return {
				healthy: true,
				postgresql: true,
				redis: true,
				checkedAt: new Date().toISOString(),
				ageMs: 0,
				version: "fixture",
			};
		},
	);
	const close = spyOn(server.services.database, "close");
	server.app.listen({ hostname: "127.0.0.1", port: 0 });
	const abort = new AbortController();
	const response = fetch(new URL("/health", server.app.server?.url), {
		signal: abort.signal,
	}).catch(() => undefined);
	try {
		await entered.promise;
		abort.abort();
		await response;
		const stopping = server.stop();
		await Bun.sleep(20);
		expect(server.services.tracker.active).toBe(1);
		expect(close).not.toHaveBeenCalled();
		release.resolve();
		await stopping;
		expect(server.services.tracker.active).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await server.stop();
		for (const mock of [send, status, close]) mock.mockRestore();
	}
});

test("a held worker and final closer share one bounded stop with an error-level forced outcome", async () => {
	const server = fixture(50, 150);
	const held = Promise.withResolvers<void>();
	const drain = spyOn(server.services.dispatcher, "drain").mockReturnValue(
		held.promise,
	);
	const close = spyOn(server.services.database, "close").mockReturnValue(
		held.promise,
	);
	const redis = spyOn(server.services.redis, "close");
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		const started = performance.now();
		await expect(server.stop()).rejects.toMatchObject({
			code: "FORCED_SHUTDOWN",
		});
		expect(performance.now() - started).toBeLessThan(1000);
		expect(redis).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(log.mock.calls)).toContain("FORCED_SHUTDOWN");
	} finally {
		held.resolve();
		for (const mock of [drain, close, redis, log]) mock.mockRestore();
		await server.services.database.close();
	}
});

test("a short diagnostics waiter expires without poisoning the shared probe", async () => {
	const held = Promise.withResolvers<boolean>();
	let calls = 0;
	const health = new HealthService(
		{
			ping: async () => {
				calls++;
				return held.promise;
			},
		},
		{ ping: async () => true },
		{ draining: false, active: 0 },
		new Metrics(),
		"fixture",
	);
	health.setPhase("serving");
	try {
		const long = health.status();
		await expect(health.diagnostics(Date.now() + 40)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		held.resolve(true);
		expect((await long).healthy).toBe(true);
		expect(calls).toBe(1);
	} finally {
		held.resolve(true);
	}
});

test("monitoring shares normal peer and principal admission even for the environment master", async () => {
	const master = new KeyGenerator().master();
	const server = fixture(500, 1500, {
		KZ_MASTER_KEY: master,
		KZ_PEER_REQUESTS_PER_MINUTE: "3",
	});
	const peer = "127.0.0.1";
	const bucket = (name: string) => `kz:rate:${new SecretHasher().hash(name)}`;
	const hits = new Map<string, number>();
	const redis = spyOn(server.services.redis, "send").mockImplementation(
		async (_command, args) => {
			const key = args[2];
			if (!key) throw new Error("Missing rate bucket");
			const count = (hits.get(key) ?? 0) + 1;
			hits.set(key, count);
			return [count, 60000];
		},
	);
	const ip = spyOn(server.services.ip, "resolve").mockResolvedValue(peer);
	const settings = spyOn(server.services.settings, "read").mockResolvedValue({
		...settingsDefaults,
		rateLimitEnabled: true,
		adminRequestsPerMinute: 1,
	});
	const authenticate = spyOn(server.services.auth, "authenticate");
	const diagnostic = spyOn(server.services.health, "diagnostics");
	server.app.listen({ hostname: "127.0.0.1", port: 0 });
	const request = (path: string, credential?: string) =>
		fetch(new URL(path, server.app.server?.url), {
			headers: credential ? { authorization: `Bearer ${credential}` } : {},
			signal: AbortSignal.timeout(3000),
		});
	try {
		expect((await request("/metrics")).status).toBe(401);
		const response = await request("/metrics", master);
		expect(response.status).toBe(200);
		await response.text();
		expect((await request("/health/diagnostics", master)).status).toBe(429);
		const blockedPeer = await request("/metrics", master);
		expect(blockedPeer.status).toBe(429);
		expect(blockedPeer.headers.get("Retry-After")).toBe("60");
		expect(hits.get(bucket(`peer:${peer}`))).toBe(4);
		expect(hits.get(bucket(`root:root:${peer}`))).toBe(2);
		expect(hits.get(bucket(`invalid:${peer}`))).toBe(1);
		expect(authenticate).toHaveBeenCalledTimes(3);
		expect(diagnostic).not.toHaveBeenCalled();
		redis.mockResolvedValue("not-a-limiter-reply");
		expect((await request("/health/diagnostics", master)).status).toBe(503);
		expect(authenticate).toHaveBeenCalledTimes(3);
		expect((await request("/live/")).status).toBe(200);
		expect(redis).toHaveBeenCalledTimes(8);
	} finally {
		await server.stop();
		for (const mock of [redis, ip, settings, authenticate, diagnostic])
			mock.mockRestore();
	}
});

test("event pruning receives the scheduler's row and deadline slice, and cannot start during drain", async () => {
	const server = fixture(500, 1500, { KZ_EVENT_RETENTION_DAYS: "7" });
	const prune = spyOn(server.services.activity, "prune").mockResolvedValue({
		removed: 2,
		retainedAfter: "2",
	});
	const deadline = Date.now() + 5000;
	try {
		await server["maintain"]({
			runOnce: async (step) => {
				if (!step)
					throw new Error("Event retention did not join scheduled cleanup");
				expect(await step(3, deadline)).toBe(2);
				expect(await step(1005, deadline)).toBe(2);
				expect(await step(8, Date.now() - 1)).toBe(0);
				server.services.tracker.draining = true;
				expect(await step(8, deadline)).toBe(0);
				return true;
			},
		});
		expect(prune.mock.calls).toEqual([
			[{ limit: 3, deadlineAt: deadline, retentionMs: 7 * 86400000 }],
			[{ limit: 1000, deadlineAt: deadline, retentionMs: 7 * 86400000 }],
		]);
	} finally {
		prune.mockRestore();
		await server.stop();
	}
});

test("prepare-restore refuses runtime-only credentials before touching either database", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"src/main.ts",
			"prepare-restore",
			"--confirm-restored-database",
		],
		{
			env: {
				PATH: Bun.env.PATH,
				KZ_DATABASE_URL: "postgresql://fixture:PRIVATE@127.0.0.1:1/runtime",
			},
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(5000),
		},
	);
	const [exit, diagnostic] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect(exit).toBe(1);
	expect(JSON.parse(diagnostic)).toMatchObject({
		category: "INVALID_CONFIGURATION",
		setting: "KZ_MIGRATION_DATABASE_URL",
	});
	expect(diagnostic).not.toContain("PRIVATE");
});
