import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { audits } from "../../core/database/schema/audits";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { receipts } from "../../core/database/schema/receipts";
import { MaintenanceService } from "../../core/MaintenanceService";
import { UserService } from "../../plugins/users/UserService";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("parent disable waits for admitted validation and blocks every later validation", async () => {
	const users = new UserService(
		context.database,
		context.auth,
		context.audit,
		context.events,
		context.settings,
		context.idempotency,
		context.deletion,
	);
	const user = await users.create({ name: "locking" }, context.operation());
	await users.enable({ ids: [user.data.id] }, context.operation());
	const issued = await context.licenses.create(
		{ userId: user.data.id },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = context.meters.consume.bind(context.meters);
	const hook = spyOn(context.meters, "consume").mockImplementationOnce(
		async (...args) => {
			held.resolve();
			await release.promise;
			return original(...args);
		},
	);
	const input = { license: issued.credential, userId: user.data.id };
	try {
		const first = context.validation.validate(input, context.operation());
		await held.promise;
		let disabled = false;
		const mutation = users
			.disable({ ids: [user.data.id] }, context.operation())
			.then(() => {
				disabled = true;
			});
		await Bun.sleep(30);
		expect(disabled).toBe(false);
		release.resolve();
		expect((await first).code).toBe("VALID");
		await mutation;
		expect(
			(await context.validation.validate(input, context.operation())).code,
		).toBe("USER_DISABLED");
	} finally {
		release.resolve();
		hook.mockRestore();
	}
});

test("zero capacity is literal and cap reduction retains the oldest registrations", async () => {
	const issued = await context.licenses.create(
		{ deviceLimit: 3, ipLimit: 3 },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	for (let n = 1; n <= 3; n++)
		expect(
			(
				await context.validation.validate(
					{ license: issued.credential, hardwareId: `device-${n}` },
					{ ...context.operation(), clientIp: `192.0.2.${n}` },
				)
			).code,
		).toBe("VALID");
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { deviceLimit: 1, ipLimit: 1 } },
		context.operation(),
	);
	expect(
		(
			await context.database.orm
				.select()
				.from(hardware)
				.where(eq(hardware.licenseId, issued.data.id))
		).map((row) => row.hardwareId),
	).toEqual(["device-1"]);
	expect(
		(
			await context.database.orm
				.select()
				.from(ips)
				.where(eq(ips.licenseId, issued.data.id))
		).map((row) => row.ip),
	).toEqual(["192.0.2.1"]);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { deviceLimit: null, ipLimit: 0 } },
		context.operation(),
	);
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(0);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).code,
	).toBe("IP_LIMIT_REACHED");
});

test("concurrent distinct IPs never exceed their cap", async () => {
	const issued = await context.licenses.create(
		{ ipLimit: 2 },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			context.validation.validate(
				{ license: issued.credential },
				{ ...context.operation(), clientIp: `198.51.100.${n + 1}` },
			),
		),
	);
	expect(results.filter((row) => row.code === "VALID")).toHaveLength(2);
	expect(
		await context.database.orm
			.select()
			.from(ips)
			.where(eq(ips.licenseId, issued.data.id)),
	).toHaveLength(2);
});

test("precision changes floor state; decrements clamp and invalid growth rolls back", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "decimal",
						limit: 10.99,
						numericMode: "decimal",
						precision: 2,
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "set", value: 4.99 },
		context.operation(),
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: {
					upsert: [{ name: "decimal", limit: 10.99, numericMode: "integer" }],
				},
			},
		},
		context.operation(),
	);
	let [meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter).toMatchObject({ value: "4", limit: "10", precision: 0 });
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "decimal", action: "decrement", value: 20 },
		context.operation(),
	);
	[meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("0");
	await context.licenses.adjust(
		{
			ids: [issued.data.id],
			name: "decimal",
			action: "set",
			value: 999999999999999,
		},
		context.operation(),
	);
	await expect(
		context.licenses.update(
			{
				ids: [issued.data.id],
				changes: {
					meters: {
						upsert: [
							{
								name: "decimal",
								limit: 10,
								numericMode: "decimal",
								precision: 6,
							},
						],
					},
				},
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	[meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("999999999999999");
});

test("overage threshold occurs once, rearms after reset, and cap edits preserve usage", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "use", limit: 2, allowOverage: true }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	for (let n = 0; n < 3; n++)
		expect(
			(
				await context.validation.validate(
					{ license: issued.credential, usage: { use: 1 } },
					context.operation(),
				)
			).code,
		).toBe("VALID");
	const where = and(
		eq(audits.targetId, issued.data.id),
		eq(audits.action, "meter.limit_reached"),
	);
	expect(
		await context.database.orm.select().from(audits).where(where),
	).toHaveLength(1);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "use", action: "reset" },
		context.operation(),
	);
	await context.validation.validate(
		{ license: issued.credential, usage: { use: 2 } },
		context.operation(),
	);
	expect(
		await context.database.orm.select().from(audits).where(where),
	).toHaveLength(2);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "use", limit: 10 }] } },
		},
		context.operation(),
	);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("2");
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { meters: { upsert: [{ name: "use", limit: 1 }] } },
		},
		context.operation(),
	);
	expect(
		await context.database.orm.select().from(audits).where(where),
	).toHaveLength(3);
});

test("failure threshold is shared atomically and unknown credential digests never persist", async () => {
	const secret = `unknown-${Bun.randomUUIDv7()}`;
	const operation = context.operation();
	await context.settings.update(
		{ failureThreshold: 3 },
		operation.principal,
		operation,
	);
	await Promise.all(
		Array.from({ length: 12 }, () =>
			context.validation.validate({ license: secret }, operation),
		),
	);
	const rows = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.requestId, operation.requestId));
	expect(rows.filter((row) => row.action === "validation.failed")).toHaveLength(
		1,
	);
	const text = JSON.stringify(rows);
	expect(text).not.toContain(secret);
	expect(text).not.toContain(
		new Bun.CryptoHasher("sha256").update(secret).digest("hex"),
	);
});

test("safe reads do not persist internal credential digests into actor evidence", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const principal = await context.auth.authenticate(
		`Bearer ${issued.credential}`,
	);
	const operation = { ...context.operation(), principal };
	await context.database.transaction((tx) =>
		context.audit.record(tx, {
			...operation,
			actor: principal,
			action: "test.actor",
			targetType: "license",
			targetId: issued.data.id,
		}),
	);
	const [row] = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.requestId, operation.requestId));
	expect(Object.keys(row?.actor ?? {}).sort()).toEqual(["id", "kind", "name"]);
});

test("maintenance resets missed periods once, expires receipts, and preserves audits", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "daily",
						limit: 10,
						schedule: { interval: "day", time: "00:00", timezone: "UTC" },
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "daily", action: "set", value: 9 },
		context.operation(),
	);
	await context.database.orm
		.update(meters)
		.set({ nextResetAt: new Date("2000-01-01T00:00:00Z") })
		.where(eq(meters.licenseId, issued.data.id));
	await context.database.orm.update(receipts).set({ expiresAt: new Date(0) });
	const maintenance = new MaintenanceService(
		context.database,
		context.meters,
		context.settings,
	);
	await Promise.all([maintenance.runOnce(), maintenance.runOnce()]);
	const [meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("0");
	expect(meter?.nextResetAt?.getTime()).toBeGreaterThan(Date.now());
	expect(meter?.lastScheduledResetAt?.getTime()).toBeLessThanOrEqual(
		meter?.lastResetAt?.getTime() ?? 0,
	);
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(
				and(
					eq(audits.targetId, issued.data.id),
					eq(audits.action, "meter.reset"),
				),
			),
	).toHaveLength(1);
	expect(await context.database.orm.select().from(receipts)).toHaveLength(0);
	expect(await context.database.orm.select().from(audits)).not.toHaveLength(0);
});

test("bulk failures roll back all targets and duplicate UUID casing is rejected", async () => {
	const issued = await context.licenses.create({}, context.operation());
	await expect(
		context.licenses.enable(
			{ ids: [issued.data.id, Bun.randomUUIDv7()] },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "BULK_OPERATION_FAILED" });
	expect(
		(
			await context.database.orm
				.select()
				.from(licenses)
				.where(eq(licenses.id, issued.data.id))
		)[0]?.enabled,
	).toBe(false);
	await expect(
		context.licenses.enable(
			{ ids: [issued.data.id, issued.data.id.toUpperCase()] },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("database rejects negative meter values", async () => {
	await expect(
		context.database.transaction((tx) =>
			tx.execute(sql`update ${meters} set value = -1`),
		),
	).rejects.toThrow();
});
