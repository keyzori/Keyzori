import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { hardware } from "../../core/database/schema/hardware";
import { meters } from "../../core/database/schema/meters";
import { licenses } from "../../core/database/schema/licenses";
import { receipts } from "../../core/database/schema/receipts";
import { KeyGenerator } from "../../core/security/KeyGenerator";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("ten competing hardware registrations produce exactly three successes", async () => {
	const issued = await context.licenses.create(
		{ deviceLimit: 3 },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const results = await Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			context.validation.validate(
				{ license: issued.credential, hardwareId: `device-${i}` },
				context.operation(),
			),
		),
	);
	expect(results.filter((result) => result.code === "VALID")).toHaveLength(3);
	expect(
		results.filter((result) => result.code === "DEVICE_LIMIT_REACHED"),
	).toHaveLength(7);
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(3);
});

test("concurrent last unit consumes once; durable replay works at the cap", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "uses", limit: 10 }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "uses", action: "set", value: 9 },
		context.operation(),
	);
	const operations = [context.operation(), context.operation()];
	const results = await Promise.all(
		operations.map((operation) =>
			context.validation.validate(
				{ license: issued.credential, usage: { uses: 1 } },
				operation,
			),
		),
	);
	expect(results.map((result) => result.code).sort()).toEqual([
		"USAGE_LIMIT_REACHED",
		"VALID",
	]);
	const winner =
		operations[results.findIndex((result) => result.code === "VALID")];
	if (!winner) throw new Error("Winner missing");
	expect(
		await context.validation.validate(
			{ license: issued.credential, usage: { uses: 1 } },
			winner,
		),
	).toEqual({ code: "VALID", reason: "License is valid" });
	const [meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("10");
	expect(
		await context.database.orm
			.select()
			.from(receipts)
			.where(eq(receipts.principalId, issued.data.id)),
	).toHaveLength(1);
	await expect(
		context.validation.validate(
			{ license: issued.credential, usage: { uses: 2 } },
			winner,
		),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});

test("one failed meter rolls back all increments and new identifiers", async () => {
	const issued = await context.licenses.create(
		{
			deviceLimit: 2,
			meters: {
				upsert: [
					{ name: "a", limit: 10 },
					{ name: "z", limit: 1 },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const result = await context.validation.validate(
		{ license: issued.credential, hardwareId: "new", usage: { a: 1, z: 2 } },
		context.operation(),
	);
	expect(result.code).toBe("USAGE_LIMIT_REACHED");
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(0);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		).map((row) => row.value),
	).toEqual(["0", "0"]);
});

test("secret issuance retry does not create another resource or persist plaintext", async () => {
	const operation = context.operation();
	const issued = await context.licenses.create({}, operation);
	await expect(context.licenses.create({}, operation)).rejects.toMatchObject({
		code: "SECRET_ALREADY_ISSUED",
		resourceIds: [issued.data.id],
	});
	const rows = await context.database.orm
		.select()
		.from(licenses)
		.where(eq(licenses.id, issued.data.id));
	expect(rows).toHaveLength(1);
	expect(JSON.stringify(rows)).not.toContain(issued.credential);
	expect(
		JSON.stringify(await context.database.orm.select().from(receipts)),
	).not.toContain(issued.credential);
});

test("credential collisions regenerate on create and rotate without replacing another licence", async () => {
	const existing = await context.licenses.create({}, context.operation());
	await context.licenses.enable(
		{ ids: [existing.data.id] },
		context.operation(),
	);
	const generate = spyOn(KeyGenerator.prototype, "license");
	try {
		generate.mockReturnValueOnce(existing.credential);
		const created = await context.licenses.create({}, context.operation());
		expect(created.credential).not.toBe(existing.credential);
		generate.mockReturnValueOnce(existing.credential);
		const rotated = await context.licenses.rotate(
			{ ids: [created.data.id] },
			context.operation(),
		);
		expect(rotated.data[0]?.credential).not.toBe(existing.credential);
		expect(rotated.data[0]?.credential).not.toBe(created.credential);
		expect(
			(
				await context.validation.validate(
					{ license: existing.credential },
					context.operation(),
				)
			).code,
		).toBe("VALID");
	} finally {
		generate.mockRestore();
	}
});

test("decimal arithmetic reaches an exact cap; integer fractions are rejected", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "decimal", limit: 0.3, numericMode: "decimal", precision: 1 },
					{ name: "integer", limit: 10 },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, usage: { decimal: 0.1 } },
				context.operation(),
			)
		).code,
	).toBe("VALID");
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, usage: { decimal: 0.2 } },
				context.operation(),
			)
		).code,
	).toBe("VALID");
	await expect(
		context.validation.validate(
			{ license: issued.credential, usage: { integer: 0.9 } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("rotated and expired credentials cannot replay accepted usage", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "uses", limit: 10 }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	await context.validation.validate(
		{ license: issued.credential, usage: { uses: 1 } },
		operation,
	);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { expiresAt: "2000-01-01T00:00:00Z" } },
		context.operation(),
	);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, usage: { uses: 1 } },
				operation,
			)
		).code,
	).toBe("LICENSE_EXPIRED");
	await context.licenses.rotate({ ids: [issued.data.id] }, context.operation());
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, usage: { uses: 1 } },
				operation,
			)
		).code,
	).toBe("LICENSE_INVALID");
});
