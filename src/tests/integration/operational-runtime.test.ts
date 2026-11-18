import { expect, spyOn, test } from "bun:test";
import { t } from "elysia";
import { eq } from "drizzle-orm";
import { Redis } from "../../core/redis/Redis";
import { Metrics } from "../../core/observability/Metrics";
import { WebhookQueueObserver } from "../../core/observability/WebhookQueueObserver";
import { observeActivity } from "../../core/observability/observeActivity";
import { deliveries } from "../../core/database/schema/deliveries";
import { TestHttp } from "../fixtures/TestHttp";
import { TestDatabase } from "../fixtures/TestDatabase";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { checkedJSON } from "../fixtures/Json";
import type { $Operation } from "../../types/operation";

test("serve refuses the fixture administrator with the typed schema-phase error before listening", async () => {
	const fixture = new TestDatabase();
	await fixture.start();
	const master = new KeyGenerator().master();
	try {
		const child = Bun.spawn(
			[process.execPath, "--no-env-file", "src/main.ts", "serve"],
			{
				env: {
					PATH: Bun.env.PATH,
					KZ_MASTER_KEY: master,
					KZ_DATABASE_URL: fixture.url,
					KZ_REDIS_URL: Bun.env.KZ_TEST_REDIS_URL,
					KZ_API_HOST: "127.0.0.1",
					KZ_LOG_LEVEL: "error",
				},
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(10000),
			},
		);
		const [exit, diagnostic, output] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(exit).toBe(1);
		expect(JSON.parse(diagnostic)).toMatchObject({
			event: "command.failed",
			command: "serve",
			phase: "schema",
			category: "RUNTIME_ROLE_REQUIRED",
		});
		const logs = diagnostic + output;
		expect(logs).not.toContain(master);
		expect(logs).not.toContain(fixture.url);
	} finally {
		await fixture.stop();
	}
});

test("a caller timeout retains its bounded wire slot; other requests succeed on the same Redis connection", async () => {
	const url = Bun.env.KZ_TEST_REDIS_URL;
	if (!url) throw new Error("Disposable Redis fixture required");
	const redis = new Redis(url, 1500, 2);
	const producer = new Redis(url);
	const key = `kz:test:inflight:${Bun.randomUUIDv7()}`;
	try {
		await Promise.all([redis.connect(), producer.connect()]);
		const original = redis.client;
		const timedOut = redis.send("BLPOP", [key, "0"], Date.now() + 75);
		const healthy = redis.ping();
		await expect(timedOut).rejects.toMatchObject({ code: "TIMEOUT" });
		await expect(redis.ping()).rejects.toMatchObject({
			code: "REDIS_CAPACITY",
		});
		expect(original.connected).toBe(true);
		await producer.send("RPUSH", [key, "completed-once"]);
		expect(await healthy).toBe(true);
		expect(redis.client).toBe(original);
		await producer.send("RPUSH", [key, "not-replayed"]);
		expect(await redis.send("LPOP", [key])).toBe("not-replayed");
	} finally {
		redis.close();
		try {
			if (producer.client.connected) await producer.send("DEL", [key]);
		} finally {
			producer.close();
		}
	}
});

test("closing a generation rejects its wire operations; explicit reconnect does not inherit their watchdogs", async () => {
	const url = Bun.env.KZ_TEST_REDIS_URL;
	if (!url) throw new Error("Disposable Redis fixture required");
	const redis = new Redis(url, 200);
	const key = `kz:test:generation:${Bun.randomUUIDv7()}`;
	try {
		await redis.connect();
		const old = redis.client;
		const command = redis.send("BLPOP", [key, "0"]);
		redis.close();
		await expect(command).rejects.toMatchObject({ code: "REDIS_CLOSED" });
		await redis.connect();
		expect(redis.client).not.toBe(old);
		await Bun.sleep(250);
		expect(await redis.ping()).toBe(true);
	} finally {
		redis.close();
	}
});

test("queue telemetry preserves its last sample; Redis admission loss denies the scrape and an admitted probe reports redacted failures", async () => {
	const context = new TestHttp();
	await context.start();
	try {
		const metrics = new Metrics();
		const observer = new WebhookQueueObserver(
			context.services.database,
			metrics,
			2,
		);
		const observe = () => observer.observe(Date.now() + 1000);
		expect(metrics.webhookDiagnostics()).toBeNull();
		expect(metrics.text()).not.toMatch(/^keyzori_webhook_pending /m);
		await observe();
		expect(metrics.webhookDiagnostics()).toMatchObject({
			pending: 0,
			claimed: 0,
			oldestSeconds: 0,
		});
		const webhookId = Bun.randomUUIDv7();
		const rows = [
			"pending",
			"claimed",
			"pending",
			"pending",
			"succeeded",
		] as const;
		for (const state of rows) {
			const id = Bun.randomUUIDv7();
			const eventId = Bun.randomUUIDv7();
			await context.services.database.orm.insert(deliveries).values({
				id,
				webhookId,
				eventId,
				state,
				global: false,
				endpointVersion: 1,
				url: "https://receiver.invalid",
				secretCiphertext: state === "succeeded" ? null : "fixture",
				terminalAt: state === "succeeded" ? new Date() : null,
				signingKeyId: id,
				payload: {
					id: eventId,
					schemaVersion: 1,
					event: "license.created",
					createdAt: new Date().toISOString(),
					resource: { id, type: "license", revision: "1" },
					data: { licenseId: id, groupId: null },
				},
				createdAt: new Date(Date.now() - 90000),
				expiresAt: new Date(Date.now() + 60000),
				...(state === "claimed"
					? { claimToken: id, leaseUntil: new Date(Date.now() + 60000) }
					: {}),
			});
		}
		await observe();
		expect(metrics.webhookDiagnostics()).toMatchObject({
			pending: 2,
			claimed: 1,
			sampleLimit: 2,
		});
		expect(metrics.webhookDiagnostics()?.oldestSeconds).toBeGreaterThan(89);
		await context.services.webhookQueue.observe(Date.now() + 1000);
		const good = context.services.metrics.webhookDiagnostics();
		expect(good).toMatchObject({ pending: 3, claimed: 1 });
		await context.services.database.orm
			.delete(deliveries)
			.where(eq(deliveries.webhookId, webhookId));
		context.services.redis.close();
		await expect(
			context.services.webhookQueue.observe(Date.now() - 1),
		).rejects.toThrow();
		for (const path of ["/metrics", "/health/diagnostics"]) {
			for (const credential of [context.master, null]) {
				const denied = await context.request(path, { credential });
				expect(denied.status).toBe(503);
				expect(denied.headers.get("content-type")).toContain(
					"application/json",
				);
				expect(await denied.json()).toMatchObject({
					ok: false,
					data: null,
					error: { code: "SERVICE_UNAVAILABLE", retryable: true },
				});
			}
		}
		expect((await context.request("/settings")).status).toBe(503);
		expect((await context.request("/live/", { credential: null })).status).toBe(
			200,
		);
		await context.services.redis.connect();
		const secret = "PRIVATE_PROBE_CREDENTIAL";
		const failedProbe = spyOn(context.services.redis, "ping").mockRejectedValue(
			new Error(secret, { cause: { code: "ECONNRESET", detail: secret } }),
		);
		try {
			const diagnostic = await context.request("/health/diagnostics");
			expect(diagnostic.status).toBe(200);
			const { data } = await checkedJSON(
				diagnostic,
				t.Object({
					data: t.Object({
						healthy: t.Boolean(),
						postgresql: t.Boolean(),
						redis: t.Boolean(),
						checks: t.Object({ redis: t.Object({ cause: t.String() }) }),
						webhookQueue: t.Object({
							pending: t.Integer(),
							claimed: t.Integer(),
							observedAt: t.String(),
						}),
					}),
				}),
			);
			expect(data).toMatchObject({
				healthy: false,
				postgresql: true,
				redis: false,
				checks: { redis: { cause: "CONNECTION_FAILED" } },
				webhookQueue: { pending: 3, claimed: 1, observedAt: good?.observedAt },
			});
			expect(JSON.stringify(data)).not.toContain(secret);
		} finally {
			failedProbe.mockRestore();
		}
		const response = await context.request("/metrics");
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("keyzori_webhook_pending 3\n");
		expect(text).toContain(
			'keyzori_admission_rejections_total{reason="limiter_unavailable"} 5',
		);
		expect(text).toContain(
			'keyzori_dependency_checks_total{dependency="redis",outcome="failure"} 1',
		);
		expect(text).not.toContain(context.master);
		await context.services.webhookQueue.observe(Date.now() + 1000);
		expect(context.services.metrics.webhookDiagnostics()).toMatchObject({
			pending: 0,
			claimed: 0,
		});
		await context.services.database.close();
		await expect(
			context.services.webhookQueue.observe(Date.now() + 1000),
		).rejects.toThrow();
		expect((await context.request("/health/diagnostics")).status).toBe(503);
	} finally {
		await context.stop();
	}
});

test("activity observations export real native byte samples, hide unsupported ones, and retain last-good freshness on failure", async () => {
	const context = new TestHttp();
	await context.start();
	const { activity, metrics } = context.services;
	const sample = (deadlineAt = Date.now() + 1500) =>
		observeActivity(activity, metrics, deadlineAt);
	const gauge = (name: string) =>
		metrics
			.text()
			.split("\n")
			.find((line) => line.startsWith(`keyzori_stream_transport_${name} `))
			?.split(" ")[1];
	const operation: $Operation = {
		principal: { kind: "root", id: "root", name: "Root", scopes: [] },
		requestId: Bun.randomUUIDv7(),
		clientIp: "127.0.0.1",
	};
	const socket = () => ({ id: Bun.randomUUIDv7(), send: () => 1, close() {} });
	const measured = { ...socket(), raw: { getBufferedAmount: () => 137 } };
	const unsupported = socket();
	try {
		expect(gauge("buffered_bytes")).toBeUndefined();
		expect(gauge("sample_available")).toBe("0");
		expect(gauge("observed_at_seconds")).toBe("0");
		await activity.open(measured, operation);
		await sample();
		expect(gauge("buffered_bytes")).toBe("137");
		expect(gauge("sample_available")).toBe("1");
		const lastGood = gauge("observed_at_seconds");
		expect(Number(lastGood)).toBeGreaterThan(0);
		await activity.open(unsupported, operation);
		await sample();
		expect(gauge("buffered_bytes")).toBeUndefined();
		expect(gauge("sample_available")).toBe("0");
		expect(gauge("observed_at_seconds")).toBe(lastGood);
		activity.close(unsupported.id);
		activity.close(measured.id);
		await sample();
		expect(gauge("buffered_bytes")).toBe("0");
		expect(gauge("sample_available")).toBe("1");
		const lastEmpty = gauge("observed_at_seconds");
		await expect(sample(Date.now() - 1)).rejects.toThrow();
		expect(gauge("buffered_bytes")).toBeUndefined();
		expect(gauge("sample_available")).toBe("0");
		expect(gauge("observed_at_seconds")).toBe(lastEmpty);
	} finally {
		activity.stop();
		await activity.drain();
		await context.stop();
	}
});
