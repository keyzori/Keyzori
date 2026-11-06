import { expect, mock, spyOn, test } from "bun:test";
import { HealthService } from "../../plugins/health/HealthService";
import {
	Metrics,
	type OperationalGauge,
} from "../../core/observability/Metrics";
import { Logger } from "../../core/observability/Logger";
import { MigrationError } from "../../core/database/MigrationService";

test("readiness and diagnostics coalesce a slow probe and phase changes bypass cached readiness", async () => {
	const pending = Promise.withResolvers<boolean>();
	const postgres = mock(() => pending.promise);
	const redis = mock(async () => true);
	const tracker = { draining: false, active: 2 };
	const health = new HealthService(
		{ ping: postgres },
		{ ping: redis },
		tracker,
		new Metrics(),
		"fixture",
		{ cacheMs: 5, timeoutMs: 1000 },
	);
	health.setPhase("schema");
	const first = health.status();
	await Bun.sleep(10);
	const diagnostics = health.diagnostics();
	const rest = Array.from({ length: 20 }, () => health.status());
	expect(postgres).toHaveBeenCalledTimes(1);
	expect(redis).toHaveBeenCalledTimes(1);
	pending.resolve(true);
	expect((await first).healthy).toBe(false);
	expect((await diagnostics).phase).toBe("schema");
	await Promise.all(rest);
	health.setPhase("serving");
	expect((await health.status()).healthy).toBe(true);
	tracker.draining = true;
	expect((await health.status()).healthy).toBe(false);
	expect((await health.diagnostics()).phase).toBe("draining");
});

test("health probe deadlines expose redacted useful causes and recover on a later probe", async () => {
	const secret = "postgres://private:DO_NOT_LOG@localhost/private";
	const postgres = mock(async (): Promise<boolean> => {
		throw new Error(secret, { cause: { code: "28P01", detail: secret } });
	});
	const redis = mock(() => new Promise<boolean>(() => {}));
	const health = new HealthService(
		{ ping: postgres },
		{ ping: redis },
		{ draining: false, active: 0 },
		new Metrics(),
		"fixture",
		{ cacheMs: 0, timeoutMs: 20 },
	);
	health.setPhase("serving");
	const result = await health.diagnostics();
	expect(result.healthy).toBe(false);
	expect(result.checks.postgresql.cause).toBe("SQLSTATE_28P01");
	expect(result.checks.redis.cause).toBe("TIMEOUT");
	expect(JSON.stringify(result)).not.toContain("DO_NOT_LOG");
	postgres.mockImplementation(async () => true);
	redis.mockImplementation(async () => true);
	expect((await health.status()).healthy).toBe(true);
});

test("operational metrics have fixed names and reject non-finite or unbounded labels", () => {
	const metrics = new Metrics();
	metrics.setGauge("keyzori_streams_active", 2);
	metrics.setGauge("keyzori_stream_queue_bytes", 2048);
	metrics.setGauge("keyzori_event_publication_lag_seconds", 5);
	metrics.retention("accepted_usage", 10, 4096);
	expect(metrics.text()).toContain("keyzori_streams_active 2\n");
	expect(metrics.text()).toContain("keyzori_stream_queue_bytes 2048\n");
	expect(() => metrics.setGauge("keyzori_streams_active", Infinity)).toThrow();
	expect(() => metrics.setGauge("keyzori_streams_active", -1)).toThrow();
	expect(() =>
		metrics.setGauge('attacker{credential="secret"}' as OperationalGauge, 1),
	).toThrow();
	expect(metrics.text()).not.toContain("secret");
});

test("operational logs do not serialize arbitrary error messages or unapproved causes", () => {
	const logs = spyOn(console, "log").mockImplementation(() => {});
	try {
		new Logger().write("error", "fixture.failed", {
			cause: "SECRET_CREDENTIAL",
		});
		new Logger().write("error", "fixture.failed", {
			cause: Logger.cause(
				new Error("SECRET_CREDENTIAL", { cause: { code: "42P01" } }),
			),
		});
		expect(JSON.stringify(logs.mock.calls)).not.toContain("SECRET_CREDENTIAL");
		expect(JSON.stringify(logs.mock.calls)).toContain("SQLSTATE_42P01");
		expect(JSON.stringify(logs.mock.calls)).toContain("UNEXPECTED_ERROR");
		expect(
			Logger.cause(
				new MigrationError("SCHEMA_INCOMPATIBLE", "SECRET_CREDENTIAL"),
			),
		).toBe("SCHEMA_INCOMPATIBLE");
	} finally {
		logs.mockRestore();
	}
});
