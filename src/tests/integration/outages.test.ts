import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { Database } from "../../core/database/Database";
import { RateLimiter } from "../../core/http/RateLimiter";
import { Redis } from "../../core/redis/Redis";
import { Metrics } from "../../core/observability/Metrics";
import { TestDatabase } from "../fixtures/TestDatabase";
import { TcpProxy } from "../fixtures/TcpProxy";

const fixture = new TestDatabase();
const redisUrl = Bun.env.KZ_TEST_REDIS_URL;
const databaseUrl = Bun.env.KZ_TEST_DATABASE_URL;
if (!redisUrl || !databaseUrl)
	throw new Error(
		"Database and Redis fixture URLs are required for outage tests",
	);
beforeAll(async () => {
	await fixture.start();
	await fixture.database.orm.execute(
		sql`create table outage_probe (id text primary key)`,
	);
});
afterAll(() => fixture.stop());

describe("Redis interruption and recovery", () => {
	test("intentional shutdown fails fast and does not reopen connections", async () => {
		const redis = new Redis(redisUrl, 100);
		await redis.connect();
		redis.close();
		const started = performance.now();
		await expect(
			new RateLimiter(redis).check(`outage:${Bun.randomUUIDv7()}`, 5),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(performance.now() - started).toBeLessThan(100);
		await Bun.sleep(30);
		expect(redis.client.connected).toBe(false);
	});

	test("unexpected disconnection denies the current command and reconnects for later work", async () => {
		const redis = new Redis(redisUrl, 200);
		await redis.connect();
		try {
			redis.client.close();
			const started = performance.now();
			await expect(redis.ping()).rejects.toThrow("Redis is disconnected");
			expect(performance.now() - started).toBeLessThan(100);
			const until = Date.now() + 1000;
			while (!redis.client.connected && Date.now() < until) await Bun.sleep(10);
			expect(await redis.ping()).toBe(true);
		} finally {
			redis.close();
		}
	});

	test("a command timeout closes its blocked connection and later commands recover without replay", async () => {
		const redis = new Redis(redisUrl, 80);
		await redis.connect();
		const key = `kz:test:blocked:${Bun.randomUUIDv7()}`;
		try {
			const started = performance.now();
			await expect(redis.send("BLPOP", [key, "0"])).rejects.toThrow(
				"Redis operation timed out",
			);
			expect(performance.now() - started).toBeLessThan(500);
			const until = Date.now() + 1000;
			while (!redis.client.connected && Date.now() < until) await Bun.sleep(10);
			expect(await redis.ping()).toBe(true);
			await redis.send("RPUSH", [key, "retained"]);
			expect(await redis.send("LPOP", [key])).toBe("retained");
		} finally {
			redis.close();
		}
	});

	test("remaining request deadline shortens the Redis command budget", async () => {
		const redis = new Redis(redisUrl, 2000);
		await redis.connect();
		try {
			const started = performance.now();
			await expect(
				redis.send(
					"BLPOP",
					[`kz:test:deadline:${Bun.randomUUIDv7()}`, "0"],
					Date.now() + 50,
				),
			).rejects.toThrow("Redis operation timed out");
			expect(performance.now() - started).toBeLessThan(500);
		} finally {
			redis.close();
		}
	});

	test("unresponsive Redis handshake is bounded while a healthy endpoint remains usable", async () => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const url = new URL(redisUrl);
		url.hostname = "127.0.0.1";
		url.port = String(listener.port);
		const redis = new Redis(url.href, 80);
		try {
			const started = performance.now();
			await expect(redis.connect()).rejects.toThrow();
			expect(performance.now() - started).toBeLessThan(500);
		} finally {
			redis.close();
			listener.stop(true);
		}
		const recovered = new Redis(redisUrl, 200);
		try {
			await recovered.connect();
			expect(await recovered.ping()).toBe(true);
		} finally {
			recovered.close();
		}
	});
});

describe("PostgreSQL interruption and recovery", () => {
	test("a stalled established connection expires, settles its callback, and preserves the pool", async () => {
		const proxy = new TcpProxy(new URL(fixture.url));
		const database = new Database(await proxy.start(), 2);
		const id = Bun.randomUUIDv7();
		let watchdogFired = false;
		let callbackSettled = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			using healthy = await database.client.reserve();
			const healthyOrm = drizzle({ client: healthy });
			const [before] = await healthyOrm
				.select({ pid: sql<number>`pg_backend_pid()` })
				.from(sql`(values (1)) as current_backend`);
			expect(before).toBeDefined();
			await database.ping();
			watchdog = setTimeout(() => {
				watchdogFired = true;
				proxy.closeConnections();
			}, 700);
			const started = performance.now();
			await expect(
				database.transaction(
					async (tx) => {
						await tx.execute(sql`insert into outage_probe (id) values (${id})`);
						proxy.dropResponses = true;
						try {
							await tx.execute(sql`select 1`);
						} finally {
							await Bun.sleep(40);
							callbackSettled = true;
						}
					},
					"write",
					Date.now() + 150,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			clearTimeout(watchdog);
			expect(watchdogFired).toBe(false);
			expect(performance.now() - started).toBeLessThan(500);
			expect(callbackSettled).toBe(true);
			proxy.dropResponses = false;
			const [after] = await healthyOrm
				.select({ pid: sql<number>`pg_backend_pid()` })
				.from(sql`(values (1)) as current_backend`);
			expect(after?.pid).toBe(before?.pid);
			expect(await database.ping()).toBe(true);
			const [probe] = await fixture.database.orm
				.select({
					exists: sql<boolean>`exists(select 1 from outage_probe where id = ${id})`,
				})
				.from(sql`(values (1)) as probe`);
			expect(probe?.exists).toBe(false);
		} finally {
			clearTimeout(watchdog);
			await proxy.stop();
			await database.close();
		}
	});

	test("a lost commit acknowledgement is bounded but the committed result remains indeterminate to its caller", async () => {
		const proxy = new TcpProxy(new URL(fixture.url));
		const database = new Database(await proxy.start(), 1);
		const id = Bun.randomUUIDv7();
		let watchdogFired = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			await database.ping();
			watchdog = setTimeout(() => {
				watchdogFired = true;
				proxy.closeConnections();
			}, 700);
			const started = performance.now();
			await expect(
				database.transaction(
					async (tx) => {
						await tx.execute(sql`insert into outage_probe (id) values (${id})`);
						proxy.dropResponses = true;
					},
					"write",
					Date.now() + 150,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			clearTimeout(watchdog);
			expect(watchdogFired).toBe(false);
			expect(performance.now() - started).toBeLessThan(500);
			const [probe] = await fixture.database.orm
				.select({
					exists: sql<boolean>`exists(select 1 from outage_probe where id = ${id})`,
				})
				.from(sql`(values (1)) as probe`);
			expect(probe?.exists).toBe(true);
			proxy.dropResponses = false;
			expect(await database.ping()).toBe(true);
		} finally {
			clearTimeout(watchdog);
			await proxy.stop();
			await database.close();
		}
	});

	test("terminated transaction rolls back and the pool opens a usable connection", async () => {
		await expect(
			fixture.database.transaction(async (tx) => {
				const [row] = await tx
					.select({ pid: sql<number>`pg_backend_pid()` })
					.from(sql`(values (1)) as current_backend`);
				if (!row) throw new Error("Backend PID missing");
				await fixture.database.orm.execute(
					sql`select pg_terminate_backend(${row.pid})`,
				);
				await tx.execute(sql`select 1`);
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(
			await fixture.database.transaction(async (tx) => {
				await tx.execute(sql`select 1`);
				return true;
			}),
		).toBe(true);
	});

	test("unresponsive connection acquisition expires before any mutation can start", async () => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const url = new URL(databaseUrl);
		url.hostname = "127.0.0.1";
		url.port = String(listener.port);
		const metrics = new Metrics();
		const unavailable = new Database(url.href, 1, metrics);
		let mutationStarted = false;
		try {
			const started = performance.now();
			await expect(
				unavailable.transaction(
					async () => {
						mutationStarted = true;
					},
					"write",
					Date.now() + 80,
				),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
			expect(performance.now() - started).toBeLessThan(500);
			expect(mutationStarted).toBe(false);
			await expect(unavailable.ping(Date.now() + 60)).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
			});
			expect(metrics.text()).toContain("keyzori_transaction_failures_total 2");
		} finally {
			listener.stop(true);
			await unavailable.close();
		}
	});
});
