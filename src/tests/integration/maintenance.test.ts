import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MaintenanceService } from "../../core/MaintenanceService";
import { audits } from "../../core/database/schema/audits";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { maintenanceRetries } from "../../core/database/schema/maintenance";
import { receipts } from "../../core/database/schema/receipts";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { Metrics } from "../../core/observability/Metrics";
import { TestContext } from "../fixtures/TestContext";

const context = new TestContext();
const maintenance = new MaintenanceService(
	context.database,
	context.meters,
	context.settings,
);
beforeAll(() => context.start());
afterAll(() => context.stop());

async function overdue(names = ["uses"], dueAt = new Date(0)) {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: names.map((name) => ({
					name,
					schedule: { interval: "day", time: "00:00", timezone: "UTC" },
				})),
			},
		},
		context.operation(),
	);
	await context.database.orm
		.update(meters)
		.set({
			value: "7",
			periodStartedAt: new Date(dueAt.getTime() - 86400000),
			nextResetAt: dueAt,
		})
		.where(eq(meters.licenseId, issued.data.id));
	return issued.data.id;
}

function balances(licenseId: string) {
	return context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, licenseId));
}

function resetAudits(licenseId: string) {
	return context.database.orm
		.select()
		.from(audits)
		.where(
			and(eq(audits.targetId, licenseId), eq(audits.action, "meter.reset")),
		);
}

test("maintenance skips locked licences and concurrent passes persist each due reset once", async () => {
	const busy = await overdue();
	const available = await overdue(["uses"], new Date(1));
	const acquired = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = context.database.orm.transaction(async (tx) => {
		await tx.select().from(licenses).where(eq(licenses.id, busy)).for("update");
		acquired.resolve();
		await release.promise;
	});
	await acquired.promise;
	try {
		await maintenance.runOnce();
		expect((await balances(busy))[0]?.value).toBe("7");
		expect((await balances(available))[0]?.value).toBe("0");
		expect(await resetAudits(busy)).toHaveLength(0);
		expect(await resetAudits(available)).toHaveLength(1);
	} finally {
		release.resolve();
		await blocker;
	}
	await Promise.all([maintenance.runOnce(), maintenance.runOnce()]);
	const reset = (await balances(busy))[0];
	expect(reset?.value).toBe("0");
	expect(reset?.lastScheduledResetAt).toBeInstanceOf(Date);
	expect(reset?.nextResetAt?.getTime()).toBeGreaterThan(Date.now());
	expect(await resetAudits(busy)).toHaveLength(1);
	expect(await resetAudits(available)).toHaveLength(1);
}, 15000);

test("a poison schedule rolls back its licence while another due licence progresses", async () => {
	const poisoned = await overdue(["a-valid", "z-invalid"]);
	const healthy = await overdue(["uses"], new Date(1));
	await context.database.orm
		.update(meters)
		.set({
			schedule: {
				interval: "day",
				time: "00:00",
				timezone: "Invalid/Maintenance",
			},
		})
		.where(and(eq(meters.licenseId, poisoned), eq(meters.name, "z-invalid")));
	try {
		await maintenance.runOnce();
		const unchanged = await balances(poisoned);
		expect(unchanged.map((row) => row.value)).toEqual(["7", "7"]);
		expect(unchanged.every((row) => row.lastResetAt === null)).toBe(true);
		expect(await resetAudits(poisoned)).toHaveLength(0);
		expect((await balances(healthy))[0]?.value).toBe("0");
		expect(await resetAudits(healthy)).toHaveLength(1);
	} finally {
		await context.database.orm
			.update(meters)
			.set({ schedule: null, periodStartedAt: null, nextResetAt: null })
			.where(eq(meters.licenseId, poisoned));
	}
});

test("durable backoff gets beyond 100 poisoned oldest licences across fresh workers", async () => {
	const healthy = await overdue(["uses"], new Date(2));
	const [template] = await context.database.orm
		.select()
		.from(licenses)
		.where(eq(licenses.id, healthy));
	if (!template) throw new Error("Missing licence template");
	const poisoned = Array.from({ length: 125 }, () => Bun.randomUUIDv7());
	await context.database.orm
		.insert(licenses)
		.values(poisoned.map((id) => ({ ...template, id, keyHash: id })));
	await context.database.orm.insert(meters).values(
		poisoned.map((licenseId) => ({
			id: Bun.randomUUIDv7(),
			licenseId,
			name: "uses",
			value: "7",
			periodStartedAt: new Date(-86400000),
			nextResetAt: new Date(1),
			schedule: {
				interval: "day" as const,
				time: "00:00",
				timezone: "Invalid/Maintenance",
			},
		})),
	);
	const makeWorker = () =>
		new MaintenanceService(
			context.database,
			context.meters,
			context.settings,
			undefined,
			{
				resetRows: 100,
				resetTimeMs: 30000,
				retryBaseMs: 3600000,
			},
		);
	try {
		await makeWorker().runOnce();
		expect(
			await context.database.orm
				.select()
				.from(maintenanceRetries)
				.where(inArray(maintenanceRetries.licenseId, poisoned)),
		).toHaveLength(100);
		expect((await balances(healthy))[0]?.value).toBe("7");
		// New service instances share no in-memory skipped list.
		await Promise.all([makeWorker().runOnce(), makeWorker().runOnce()]);
		expect((await balances(healthy))[0]?.value).toBe("0");
		expect(await resetAudits(healthy)).toHaveLength(1);
		const retries = await context.database.orm
			.select()
			.from(maintenanceRetries)
			.where(inArray(maintenanceRetries.licenseId, poisoned));
		expect(retries).toHaveLength(poisoned.length);
		expect(
			retries.every(
				(row) => row.attempts === 1 && row.nextAttemptAt > row.attemptedAt,
			),
		).toBe(true);
		expect(
			await context.database.orm
				.select()
				.from(audits)
				.where(
					and(
						inArray(audits.targetId, poisoned),
						eq(audits.action, "meter.reset"),
					),
				),
		).toHaveLength(0);
		// Foreground lazy resets remain authoritative even while maintenance backs off.
		const repaired = poisoned[0];
		if (!repaired) throw new Error("Missing poisoned licence");
		await context.database.orm
			.update(meters)
			.set({ schedule: { interval: "day", time: "00:00", timezone: "UTC" } })
			.where(eq(meters.licenseId, repaired));
		await context.database.transaction(async (tx) => {
			await tx
				.select()
				.from(licenses)
				.where(eq(licenses.id, repaired))
				.for("update");
			await context.meters.effective(
				tx,
				repaired,
				{
					actor: { kind: "system", id: "test", name: "Test" },
					action: "meter.reset",
					targetType: "license",
					targetId: repaired,
					requestId: Bun.randomUUIDv7(),
					clientIp: "",
				},
				new Date(),
			);
		});
		expect((await balances(repaired))[0]?.value).toBe("0");
	} finally {
		await context.database.orm
			.delete(licenses)
			.where(inArray(licenses.id, poisoned));
	}
}, 60000);

test("cleanup obeys its row budget and retains immutable audit and accepted deduplication evidence", async () => {
	const id = Bun.randomUUIDv7();
	const old = new Date(0);
	const keys = Array.from({ length: 7 }, () => Bun.randomUUIDv7());
	await context.database.orm.insert(receipts).values(
		keys.map((key) => ({
			operation: "ops.retention",
			principalId: id,
			key,
			fingerprint: "fixture",
			createdAt: old,
			expiresAt: old,
		})),
	);
	await context.database.orm.insert(usageOperations).values({
		id,
		licenseId: id,
		principalId: id,
		idempotencyKey: id,
		fingerprint: "fixture",
		requestId: id,
		entries: [],
		createdAt: old,
	});
	await context.database.orm.insert(audits).values({
		id,
		action: "retained",
		actor: { kind: "system", id: "test", name: "Test" },
		targetType: "license",
		targetId: id,
		requestId: id,
		createdAt: old,
	});
	const metrics = new Metrics();
	const worker = new MaintenanceService(
		context.database,
		context.meters,
		context.settings,
		undefined,
		{ cleanupRows: 3 },
		metrics,
	);
	await worker.runOnce();
	expect(
		await context.database.orm
			.select()
			.from(receipts)
			.where(eq(receipts.principalId, id)),
	).toHaveLength(4);
	await worker.runOnce();
	await worker.runOnce();
	expect(
		await context.database.orm
			.select()
			.from(receipts)
			.where(eq(receipts.principalId, id)),
	).toHaveLength(0);
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.id, id)),
	).toHaveLength(1);
	expect(
		await context.database.orm.select().from(audits).where(eq(audits.id, id)),
	).toHaveLength(1);
	await expect(
		context.database.orm
			.insert(usageOperations)
			.values({
				id: Bun.randomUUIDv7(),
				licenseId: id,
				principalId: id,
				idempotencyKey: id,
				fingerprint: "fixture",
				requestId: id,
				entries: [],
			})
			.execute(),
	).rejects.toMatchObject({
		cause: { errno: "23505", constraint: "usage_operation_identity" },
	});
	expect(metrics.text()).toContain(
		'keyzori_retained_bytes{table="accepted_usage"}',
	);
	expect(metrics.text()).not.toContain(id);
});

test("cleanup time budget cancels blocked work and leaves its transaction uncommitted", async () => {
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = context.database.transaction(async (tx) => {
		await tx.execute(
			sql`lock table idempotency_receipts in access exclusive mode`,
		);
		held.resolve();
		await release.promise;
	}, "none");
	await held.promise;
	try {
		const worker = new MaintenanceService(
			context.database,
			context.meters,
			context.settings,
			undefined,
			{ cleanupTimeMs: 100 },
		);
		const started = performance.now();
		await expect(worker.runOnce()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(performance.now() - started).toBeLessThan(2500);
	} finally {
		release.resolve();
		await blocker;
	}
});

test("history cleanup is bounded and retains old pending and claimed deliveries", async () => {
	const operation = context.operation();
	await context.settings.update(
		{ webhookHistoryDays: 1 },
		operation.principal,
		operation,
	);
	const webhookId = Bun.randomUUIDv7();
	const old = new Date("2020-01-01T00:00:00.000Z");
	function delivery(
		state: typeof deliveries.$inferInsert.state,
		createdAt: Date,
	): typeof deliveries.$inferInsert {
		const id = Bun.randomUUIDv7();
		const eventId = Bun.randomUUIDv7();
		const licenseId = Bun.randomUUIDv7();
		return {
			id,
			webhookId,
			eventId,
			groupId: null,
			global: false,
			endpointVersion: 1,
			url: "https://example.invalid/webhook",
			secretCiphertext: "unused-disposable-fixture",
			signingKeyId: Bun.randomUUIDv7(),
			payload: {
				schemaVersion: 1,
				id: eventId,
				event: "license.created",
				resource: { type: "license", id: licenseId, revision: "1" },
				data: { licenseId, groupId: null },
				createdAt: createdAt.toISOString(),
			},
			state,
			createdAt,
			expiresAt: new Date(old.getTime() + 1000),
			...(state === "claimed"
				? { claimToken: Bun.randomUUIDv7(), leaseUntil: old, attempts: 1 }
				: {}),
		};
	}
	const terminalStates = ["succeeded", "failed", "cancelled"] as const;
	const terminal = Array.from({ length: 1003 }, (_, index) =>
		delivery(
			terminalStates[index % terminalStates.length],
			new Date(old.getTime() + index),
		),
	);
	const pending = delivery("pending", old);
	const claimed = delivery("claimed", old);
	const recent = delivery("succeeded", new Date());
	const unfinished = delivery("cancelled", old);
	await context.database.orm
		.insert(deliveries)
		.values([...terminal, pending, claimed, recent, unfinished]);
	const oldest = terminal[0];
	if (!oldest) throw new Error("Missing terminal delivery fixture");
	await context.database.orm.insert(deliveryAttempts).values({
		id: Bun.randomUUIDv7(),
		deliveryId: oldest.id,
		attempt: 1,
		startedAt: old,
		completedAt: old,
	});
	await context.database.orm.insert(deliveryAttempts).values({
		id: Bun.randomUUIDv7(),
		deliveryId: unfinished.id,
		attempt: 1,
		startedAt: old,
	});
	const remaining = () =>
		context.database.orm
			.select()
			.from(deliveries)
			.where(eq(deliveries.webhookId, webhookId));
	await maintenance.runOnce();
	const first = await remaining();
	// The completed child attempt consumes one of the 1,000 deleted-row slots.
	expect(first).toHaveLength(8);
	expect(first.some((row) => row.id === pending.id)).toBe(true);
	expect(first.some((row) => row.id === claimed.id)).toBe(true);
	expect(first.some((row) => row.id === recent.id)).toBe(true);
	expect(first.some((row) => row.id === unfinished.id)).toBe(true);
	expect(
		await context.database.orm
			.select()
			.from(deliveryAttempts)
			.where(eq(deliveryAttempts.deliveryId, oldest.id)),
	).toHaveLength(0);
	await maintenance.runOnce();
	expect((await remaining()).map((row) => row.id).sort()).toEqual(
		[pending.id, claimed.id, recent.id, unfinished.id].sort(),
	);
});
