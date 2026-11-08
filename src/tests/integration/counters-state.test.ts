import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { TypeBoxValidator } from "elysia";
import { audits } from "../../core/database/schema/audits";
import { activityEvents } from "../../core/database/schema/events";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { receipts } from "../../core/database/schema/receipts";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { meterModel } from "../../plugins/licenses/meterModel";
import { TestContext } from "../fixtures/TestContext";
import type { $AuditInput } from "../../types/audit";
import type { $Transaction } from "../../types/database";
import type { $MeterChanges, $MeterSchedule } from "../../types/meters";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function locked<T>(
	licenseId: string,
	at: string,
	work: (tx: $Transaction, now: Date, evidence: $AuditInput) => Promise<T>,
) {
	return context.database.transaction(async (tx) => {
		await tx
			.select()
			.from(licenses)
			.where(eq(licenses.id, licenseId))
			.for("update");
		const operation = context.operation();
		return work(tx, new Date(at), {
			...operation,
			actor: operation.principal,
			action: "meter.updated",
			targetType: "license",
			targetId: licenseId,
		});
	});
}

function define(licenseId: string, changes: $MeterChanges, at: string) {
	return locked(licenseId, at, (tx, now, evidence) =>
		context.meters.definitions(tx, licenseId, changes, evidence, now),
	);
}

function consume(licenseId: string, usage: Record<string, string>, at: string) {
	return locked(licenseId, at, async (tx, now, evidence) => {
		const rows = await context.meters.effective(tx, licenseId, evidence, now);
		return context.meters.consume(tx, rows, usage, evidence, now);
	});
}

async function stored(licenseId: string) {
	return context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, licenseId))
		.orderBy(asc(meters.name));
}

async function events(licenseId: string) {
	return context.database.orm
		.select()
		.from(activityEvents)
		.where(sql`${activityEvents.payload}->'data'->>'licenseId' = ${licenseId}`)
		.orderBy(asc(activityEvents.ordinal));
}

async function history(licenseId: string) {
	return {
		meters: await stored(licenseId),
		events: await events(licenseId),
		audits: await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, licenseId))
			.orderBy(asc(audits.id)),
		usage: await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, licenseId))
			.orderBy(asc(usageOperations.id)),
	};
}

test("counters are opt-in and default to unlimited lifetime integer balances", async () => {
	const issued = await context.licenses.create({}, context.operation());
	expect(issued.data.meters).toEqual([]);
	await define(
		issued.data.id,
		{ upsert: [{ name: "requests" }] },
		"2026-01-01T00:00:00Z",
	);
	const [row] = await stored(issued.data.id);
	if (!row) throw new Error("Missing counter");
	const view = context.meters.view(row);
	expect(new TypeBoxValidator(meterModel.resource).Check(view)).toBe(true);
	expect(view).toMatchObject({
		counterId: row.id,
		definitionRevision: 1,
		resetGeneration: 0,
		limit: null,
		value: "0",
		numericMode: "integer",
		precision: 0,
		startsAt: null,
		schedule: null,
		periodStartedAt: null,
		periodEndsAt: null,
	});
	const [entry] = await consume(
		issued.data.id,
		{ requests: "9" },
		"2026-01-02T00:00:00Z",
	);
	if (!entry) throw new Error("Missing usage entry");
	expect(new TypeBoxValidator(meterModel.usageEntry).Check(entry)).toBe(true);
	expect(entry).toMatchObject({
		counterId: row.id,
		periodId: view.periodId,
		before: "0",
		after: "9",
	});
	await expect(
		consume(issued.data.id, { requests: "0.1" }, "2026-01-02T00:00:01Z"),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test.each([
	null,
	{ interval: "month", anchorAt: "2026-01-31T12:00:00" },
] satisfies ($MeterSchedule | null)[])(
	"consumption start is inclusive and independent of schedule %j",
	async (schedule) => {
		const issued = await context.licenses.create({}, context.operation());
		await define(
			issued.data.id,
			{
				upsert: [
					{ name: "requests", startsAt: "2026-01-15T09:30:00Z", schedule },
				],
			},
			"2026-01-01T00:00:00Z",
		);
		const before = await history(issued.data.id);
		await expect(
			consume(issued.data.id, { requests: "1" }, "2026-01-15T09:29:59.999Z"),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await history(issued.data.id)).toEqual(before);
		const [at] = await consume(
			issued.data.id,
			{ requests: "1" },
			"2026-01-15T09:30:00.000Z",
		);
		const [after] = await consume(
			issued.data.id,
			{ requests: "1" },
			"2026-01-15T09:30:00.001Z",
		);
		expect(at?.after).toBe("1");
		expect(after?.after).toBe("2");
		expect(after?.periodId).toBe(at?.periodId);
		expect(at?.periodStartedAt).toBe(
			schedule ? "2025-12-31T12:00:00.000Z" : null,
		);
		expect(at?.periodEndsAt).toBe(schedule ? "2026-01-31T12:00:00.000Z" : null);
	},
);

test("future consumption starts and exhausted counters do not affect licence validation or write usage", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "requests", startsAt: "2099-01-01T00:00:00Z", limit: "0" },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const before = await history(issued.data.id);
	const result = await context.validation.validate(
		{ license: issued.credential },
		context.operation(),
	);
	expect(result.data).toMatchObject({
		valid: true,
		code: "VALID",
		license: { meters: [{ value: "0", limit: "0" }] },
	});
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { requests: "1" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(await history(issued.data.id)).toEqual(before);
});

test("scheduled projections are read-only and share period identity with the later persisted reset", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await define(
		issued.data.id,
		{
			upsert: [
				{
					name: "requests",
					schedule: { interval: "month", anchorAt: "2026-01-31T12:00:00" },
				},
			],
		},
		"2026-01-31T12:00:00Z",
	);
	const [january] = await consume(
		issued.data.id,
		{ requests: "3" },
		"2026-02-01T00:00:00Z",
	);
	const before = await history(issued.data.id);
	const row = before.meters[0];
	if (!row) throw new Error("Missing counter");
	const projected = await context.database.transaction((tx) =>
		context.meters.projection(tx, row, new Date("2026-02-28T12:00:00Z")),
	);
	expect(projected).toMatchObject({
		value: "0",
		definitionRevision: 1,
		resetGeneration: 0,
		periodStartedAt: "2026-02-28T12:00:00.000Z",
		periodEndsAt: "2026-03-31T12:00:00.000Z",
	});
	expect(projected.periodId).not.toBe(january?.periodId);
	expect(await history(issued.data.id)).toEqual(before);
	const [february] = await consume(
		issued.data.id,
		{ requests: "1" },
		"2026-02-28T12:00:00Z",
	);
	expect(february?.periodId).toBe(projected.periodId);
	expect(february?.before).toBe("0");
	await locked(issued.data.id, "2026-03-01T00:00:00Z", (tx, now, evidence) =>
		context.meters.adjust(
			tx,
			issued.data.id,
			"requests",
			"reset",
			undefined,
			evidence,
			now,
		),
	);
	const [manuallyReset] = await consume(
		issued.data.id,
		{ requests: "1" },
		"2026-03-01T00:00:00Z",
	);
	expect(manuallyReset).toMatchObject({
		definitionRevision: 1,
		resetGeneration: 1,
		periodStartedAt: february?.periodStartedAt,
		periodEndsAt: february?.periodEndsAt,
	});
	expect(manuallyReset?.periodId).not.toBe(february?.periodId);
	const resets = (await events(issued.data.id)).filter(
		(event) => event.event === "meter.reset",
	);
	expect(resets).toHaveLength(2);
	expect(resets[0]?.payload.data).toMatchObject({
		counterId: row.id,
		resetGeneration: 0,
		periodId: february?.periodId,
	});
	expect(resets[1]?.payload.data).toMatchObject({
		counterId: row.id,
		resetGeneration: 1,
		periodId: manuallyReset?.periodId,
	});
});

test("schedule edits preserve balances but create a new definition period, including removal of resets", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await define(
		issued.data.id,
		{
			upsert: [
				{
					name: "requests",
					schedule: { interval: "month", anchorAt: "2026-01-31T12:00:00" },
				},
			],
		},
		"2026-01-31T12:00:00Z",
	);
	const [original] = await consume(
		issued.data.id,
		{ requests: "3" },
		"2026-02-01T00:00:00Z",
	);
	await define(
		issued.data.id,
		{
			upsert: [
				{
					name: "requests",
					schedule: { interval: "month", anchorAt: "2026-01-15T12:00:00" },
				},
			],
		},
		"2026-02-10T00:00:00Z",
	);
	const [edited] = await consume(
		issued.data.id,
		{ requests: "1" },
		"2026-02-10T00:00:00Z",
	);
	expect(edited).toMatchObject({
		counterId: original?.counterId,
		definitionRevision: 2,
		resetGeneration: 0,
		before: "3",
		after: "4",
		periodStartedAt: "2026-01-15T12:00:00.000Z",
		periodEndsAt: "2026-02-15T12:00:00.000Z",
	});
	expect(edited?.periodId).not.toBe(original?.periodId);
	await define(
		issued.data.id,
		{ upsert: [{ name: "requests", schedule: null }] },
		"2026-02-11T00:00:00Z",
	);
	const [lifetime] = await consume(
		issued.data.id,
		{ requests: "1" },
		"2026-02-15T12:00:00Z",
	);
	expect(lifetime).toMatchObject({
		counterId: original?.counterId,
		definitionRevision: 3,
		resetGeneration: 0,
		before: "4",
		after: "5",
		periodStartedAt: null,
		periodEndsAt: null,
	});
	expect(lifetime?.periodId).not.toBe(edited?.periodId);
});

test("definition edits, manual resets, rotation and same-name recreation preserve accepted usage identity", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "requests", limit: "10" }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	const input = { licenseId: issued.data.id, usage: { requests: "2" } };
	const first = await context.licenses.consume(input, operation);
	const original = first.data.entries[0];
	if (!original) throw new Error("Missing usage evidence");
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "requests", limit: "20" }] } },
		},
		context.operation(),
	);
	const edited = await context.licenses.consume(input, context.operation());
	expect(edited.data.entries[0]).toMatchObject({
		counterId: original.counterId,
		definitionRevision: 2,
		resetGeneration: 0,
		before: "2",
		after: "4",
	});
	expect(edited.data.entries[0]?.periodId).not.toBe(original.periodId);
	const beforeNoop = await history(issued.data.id);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "requests", limit: "20.0" }] } },
		},
		context.operation(),
	);
	expect(await history(issued.data.id)).toEqual(beforeNoop);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "requests", action: "reset" },
		context.operation(),
	);
	const reset = await context.licenses.consume(input, context.operation());
	expect(reset.data.entries[0]).toMatchObject({
		counterId: original.counterId,
		definitionRevision: 2,
		resetGeneration: 1,
		before: "0",
	});
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { meters: { remove: ["requests"] } } },
		context.operation(),
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "requests" }] } },
		},
		context.operation(),
	);
	const recreated = await context.licenses.consume(input, context.operation());
	expect(recreated.data.entries[0]?.counterId).not.toBe(original.counterId);
	expect(recreated.data.entries[0]).toMatchObject({
		definitionRevision: 1,
		resetGeneration: 0,
		before: "0",
	});
	await context.licenses.rotate({ ids: [issued.data.id] }, context.operation());
	const replay = await context.licenses.consume(input, operation);
	expect(replay.data).toEqual({ ...first.data, replayed: true });
	const [saved] = await context.database.orm
		.select()
		.from(usageOperations)
		.where(eq(usageOperations.id, first.data.id));
	expect(saved?.entries).toEqual(first.data.entries);
});

test("multi-counter rejection rolls back overdue resets, prior increments, crossing events and all evidence", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "a",
						limit: "1",
						schedule: { interval: "day", time: "00:00" },
					},
					{ name: "z", limit: "0" },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const a = (await stored(issued.data.id)).find((row) => row.name === "a");
	if (!a) throw new Error("Missing scheduled counter");
	// Seed a missed period in this disposable fixture so consumption must reset it.
	await context.database.orm
		.update(meters)
		.set({
			value: "1",
			periodStartedAt: new Date("2020-01-01T00:00:00Z"),
			nextResetAt: new Date("2020-01-02T00:00:00Z"),
		})
		.where(eq(meters.id, a.id));
	const before = await history(issued.data.id);
	const operation = context.operation();
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { a: "1", z: "1" } },
			operation,
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(await history(issued.data.id)).toEqual(before);
	expect(
		await context.database.orm
			.select()
			.from(receipts)
			.where(eq(receipts.key, operation.idempotencyKey ?? "")),
	).toEqual([]);
});

test("definition, adjustment and limit-crossing events are emitted once with transactional identities", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "requests", limit: "10" }] } },
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "requests", action: "set", value: "8" },
		context.operation(),
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "requests", limit: "5" }] } },
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{
			ids: [issued.data.id],
			name: "requests",
			action: "decrement",
			value: "4",
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{
			ids: [issued.data.id],
			name: "requests",
			action: "increment",
			value: "1",
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "requests", action: "reset" },
		context.operation(),
	);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { meters: { remove: ["requests"] } } },
		context.operation(),
	);
	const emitted = (await events(issued.data.id)).filter((event) =>
		event.event.startsWith("meter."),
	);
	expect(emitted.map((event) => event.event)).toEqual([
		"meter.created",
		"meter.adjusted",
		"meter.updated",
		"meter.limit_reached",
		"meter.adjusted",
		"meter.adjusted",
		"meter.limit_reached",
		"meter.reset",
		"meter.deleted",
	]);
	const counterId = issued.data.meters[0]?.counterId;
	for (const event of emitted)
		expect(event.payload.data).toMatchObject({
			licenseId: issued.data.id,
			counterId,
		});
	expect(emitted[3]?.payload.data).toMatchObject({
		definitionRevision: 2,
		resetGeneration: 0,
		value: "8",
		limit: "5",
	});
	expect(emitted[6]?.payload.data).toMatchObject({
		definitionRevision: 2,
		resetGeneration: 0,
		value: "5",
		limit: "5",
	});
	expect(emitted[8]?.payload.data).toMatchObject({
		definitionRevision: 2,
		resetGeneration: 1,
		value: "0",
	});
});

test("exact decimal range and precision rejection retain balances and revisions", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [{ name: "credits", numericMode: "decimal", precision: 6 }],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await context.licenses.adjust(
		{
			ids: [issued.data.id],
			name: "credits",
			action: "set",
			value: "999999999.999998",
		},
		context.operation(),
	);
	const accepted = await context.licenses.consume(
		{ licenseId: issued.data.id, usage: { credits: "0.000001" } },
		context.operation(),
	);
	expect(accepted.data.entries[0]).toMatchObject({
		before: "999999999.999998",
		after: "999999999.999999",
	});
	const before = await history(issued.data.id);
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { credits: "0.000001" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		context.licenses.update(
			{
				ids: [issued.data.id],
				changes: { meters: { upsert: [{ name: "credits", precision: 5 }] } },
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	expect(await history(issued.data.id)).toEqual(before);
});

test("a later invalid definition rolls back earlier definitions and their audit/events", async () => {
	const issued = await context.licenses.create({}, context.operation());
	const before = await history(issued.data.id);
	await expect(
		context.licenses.update(
			{
				ids: [issued.data.id],
				changes: {
					meters: {
						upsert: [
							{ name: "first", limit: "1" },
							{ name: "invalid", numericMode: "integer", limit: "0.1" },
						],
					},
				},
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	expect(await history(issued.data.id)).toEqual(before);
});
