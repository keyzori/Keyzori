import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { meters } from "../../core/database/schema/meters";
import { audits } from "../../core/database/schema/audits";
import { licenses } from "../../core/database/schema/licenses";
import { receipts } from "../../core/database/schema/receipts";
import { activityEvents } from "../../core/database/schema/events";
import { Replay } from "../../core/security/Replay";
import { TestContext } from "../fixtures/TestContext";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function scheduled() {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "uses",
						limit: "10",
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	return issued;
}

test("licence reads project due balances without resetting or creating audit history", async () => {
	const issued = await scheduled();
	await context.database.orm
		.update(meters)
		.set({
			value: "5",
			periodStartedAt: new Date(-86400000),
			nextResetAt: new Date(0),
		})
		.where(eq(meters.licenseId, issued.data.id));
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			context.licenses.read(
				new URLSearchParams({ id: issued.data.id }),
				context.operation(),
			),
		),
	);
	for (const result of results)
		expect(result.data).toMatchObject({ meters: [{ value: "0" }] });
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("5");
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, issued.data.id)),
	).toHaveLength(before.length);
});

test("editing a due schedule applies the old reset before disabling that schedule", async () => {
	const issued = await scheduled();
	await context.database.orm
		.update(meters)
		.set({
			value: "5",
			periodStartedAt: new Date(-86400000),
			nextResetAt: new Date(0),
		})
		.where(eq(meters.licenseId, issued.data.id));
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "uses", schedule: null }] } },
		},
		context.operation(),
	);
	const [row] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(row).toMatchObject({ value: "0", schedule: null, nextResetAt: null });
	expect(row?.lastResetAt).not.toBeNull();
});

test("invalid definition changes roll back their scheduled reset and evidence", async () => {
	const issued = await scheduled();
	await context.database.orm
		.update(meters)
		.set({
			value: "5",
			periodStartedAt: new Date(-86400000),
			nextResetAt: new Date(0),
		})
		.where(eq(meters.licenseId, issued.data.id));
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	await expect(
		context.licenses.update(
			{ ids: [issued.data.id], changes: { meters: { remove: ["unknown"] } } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_USAGE_METER" });
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("5");
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, issued.data.id)),
	).toHaveLength(before.length);
});

test("setting an identical decimal value produces no duplicate audit", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "decimal",
						limit: null,
						numericMode: "decimal",
						precision: 2,
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "set", value: "1.20" },
		context.operation(),
	);
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "set", value: "1.2" },
		context.operation(),
	);
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, issued.data.id)),
	).toHaveLength(before.length);
});

test("decimal sums reach an integer-valued cap without duplicate no-op audit", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "decimal", limit: "1", numericMode: "decimal", precision: 2 },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	for (const amount of ["0.1", "0.9"])
		await context.licenses.consume(
			{ licenseId: issued.data.id, usage: { decimal: amount } },
			context.operation(),
		);
	const events = await context.database.orm
		.select()
		.from(activityEvents)
		.where(
			sql`${activityEvents.payload}->'data'->>'licenseId' = ${issued.data.id}`,
		);
	expect(
		events.filter((event) => event.event === "meter.limit_reached"),
	).toHaveLength(1);
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "set", value: "1" },
		context.operation(),
	);
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, issued.data.id)),
	).toHaveLength(before.length);
});

test("idempotency expiry is evaluated after waiting for its command lock", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	const input = { ids: [issued.data.id] };
	await context.licenses.disable(input, operation);
	await context.licenses.enable(input, context.operation());
	await context.database.orm
		.update(receipts)
		.set({ expiresAt: new Date(Date.now() + 200) })
		.where(eq(receipts.key, operation.idempotencyKey ?? ""));
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

test("counter adjustments use database time after waiting for the licence lock", async () => {
	const issued = await scheduled();
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
		{ ids: [issued.data.id], name: "uses", action: "increment", value: "1" },
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
