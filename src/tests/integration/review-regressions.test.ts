import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { meters } from "../../core/database/schema/meters";
import { audits } from "../../core/database/schema/audits";
import { licenses } from "../../core/database/schema/licenses";
import { receipts } from "../../core/database/schema/receipts";
import { Replay } from "../../core/security/Replay";
import { TestContext } from "../fixtures/TestContext";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("concurrent licence self reads do not deadlock while upgrading their locks", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const operation = { ...context.operation(), principal };
	const results = await Promise.allSettled(
		Array.from({ length: 4 }, () => context.licenses.self(operation)),
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(4);
});

test("editing a due meter schedule applies the previous period reset before disabling its schedule", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "uses",
						limit: 10,
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		context.operation(),
	);
	await context.database.orm
		.update(meters)
		.set({ value: "5", nextResetAt: new Date(Date.now() - 86400000) })
		.where(eq(meters.licenseId, issued.data.id));
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: { upsert: [{ name: "uses", limit: 10, schedule: null }] },
			},
		},
		context.operation(),
	);
	const [row] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(row?.value).toBe("0");
	expect(row?.lastScheduledResetAt).not.toBeNull();
});

test("switching to integer mode accepts a cap inside the new numeric range", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "uses", limit: 10, numericMode: "decimal", precision: 6 },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: {
					upsert: [
						{ name: "uses", limit: 10000000000, numericMode: "integer" },
					],
				},
			},
		},
		context.operation(),
	);
	const [row] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(row?.limit).toBe("10000000000");
	expect(row?.precision).toBe(0);
});

test("setting a decimal meter to its current numeric value does not create an audit", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "uses", limit: 10, numericMode: "decimal", precision: 2 },
				],
			},
		},
		context.operation(),
	);
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "uses", action: "set", value: 0 },
		context.operation(),
	);
	const after = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	expect(after).toHaveLength(before.length);
});

test("reduced precision floors values and caps against the new range and rejects excess input scale", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "uses", limit: 10, numericMode: "decimal", precision: 6 },
				],
			},
		},
		context.operation(),
	);
	await context.database.orm
		.update(meters)
		.set({ value: "7.123456" })
		.where(eq(meters.licenseId, issued.data.id));
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: {
					upsert: [{ name: "uses", limit: 10000000000.1234, precision: 2 }],
				},
			},
		},
		context.operation(),
	);
	const [row] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(row?.value).toBe("7.12");
	expect(row?.limit).toBe("10000000000.12");
	await expect(
		context.licenses.update(
			{
				ids: [issued.data.id],
				changes: {
					meters: {
						upsert: [{ name: "uses", limit: 10.123, numericMode: "integer" }],
					},
				},
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: {
					upsert: [{ name: "uses", limit: 10.99, numericMode: "integer" }],
				},
			},
		},
		context.operation(),
	);
	const [integer] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(integer?.value).toBe("7");
	expect(integer?.limit).toBe("10");
});

test("definition deletion applies due resets and invalid definition mutations roll them back", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "uses",
						limit: 10,
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		context.operation(),
	);
	await context.database.orm
		.update(meters)
		.set({ value: "5", nextResetAt: new Date(Date.now() - 86400000) })
		.where(eq(meters.licenseId, issued.data.id));
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	await expect(
		context.licenses.update(
			{ ids: [issued.data.id], changes: { meters: { remove: ["missing"] } } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_USAGE_METER" });
	const [rolledBack] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(rolledBack?.value).toBe("5");
	expect(rolledBack?.lastScheduledResetAt).toBeNull();
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, issued.data.id)),
	).toHaveLength(before.length);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { meters: { remove: ["uses"] } } },
		context.operation(),
	);
	const evidence = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	expect(evidence.filter((row) => row.action === "meter.reset")).toHaveLength(
		1,
	);
	expect(
		evidence.find((row) => row.action === "meter.deleted")?.before,
	).toMatchObject({ value: "0" });
});

test("idempotency expiry is checked after waiting for the command lock", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = {
		...context.operation(),
		idempotencyKey: Bun.randomUUIDv7(),
	};
	const input = { ids: [issued.data.id] };
	await context.licenses.disable(input, operation);
	await context.licenses.enable(input, context.operation());
	await context.database.orm
		.update(receipts)
		.set({ expiresAt: new Date(Date.now() + 200) })
		.where(eq(receipts.key, operation.idempotencyKey));
	const acquired = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = context.database.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["license.disable", operation.principal.id, operation.idempotencyKey])}, 0))`,
		);
		acquired.resolve();
		await release.promise;
	});
	await acquired.promise;
	const retry = context.licenses.disable(input, operation).then(
		() => true,
		(error) => {
			if (!(error instanceof Replay)) throw error;
			return false;
		},
	);
	try {
		await Bun.sleep(300);
	} finally {
		release.resolve();
		await blocker;
	}
	expect(await retry).toBe(true);
	expect(
		(
			await context.database.orm
				.select()
				.from(licenses)
				.where(eq(licenses.id, issued.data.id))
		)[0]?.enabled,
	).toBe(false);
});

test("admin meter adjustments use time after waiting for the licence lock", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "uses",
						limit: 10,
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		context.operation(),
	);
	const acquired = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = context.database.orm.transaction(async (tx) => {
		await tx
			.select()
			.from(licenses)
			.where(eq(licenses.id, issued.data.id))
			.for("update");
		acquired.resolve();
		await release.promise;
	});
	await acquired.promise;
	await context.database.orm
		.update(meters)
		.set({ value: "5", nextResetAt: new Date(Date.now() + 150) })
		.where(eq(meters.licenseId, issued.data.id));
	const adjustment = context.licenses.adjust(
		{ ids: [issued.data.id], name: "uses", action: "increment", value: 1 },
		context.operation(),
	);
	try {
		await Bun.sleep(250);
	} finally {
		release.resolve();
		await blocker;
	}
	await adjustment;
	const [row] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(row?.value).toBe("1");
	expect(row?.lastScheduledResetAt).not.toBeNull();
});
