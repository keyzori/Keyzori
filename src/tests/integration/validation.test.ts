import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { meters } from "../../core/database/schema/meters";
import { licenses } from "../../core/database/schema/licenses";
import { receipts } from "../../core/database/schema/receipts";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { KeyGenerator } from "../../core/security/KeyGenerator";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function active(limit: string | null = "1") {
	const issued = await context.licenses.create(
		{
			metadata: { purpose: "auth-token", nested: { visible: true } },
			meters: { upsert: [{ name: "requests", limit }] },
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	return issued;
}

test("validation returns full data without consuming; exhausted counters do not invalidate", async () => {
	const issued = await active();
	await context.licenses.consume(
		{ licenseId: issued.data.id, usage: { requests: "1" } },
		context.operation(),
	);
	const result = await context.validation.validate(
		{ license: issued.credential },
		context.operation(),
	);
	expect(result.data).toMatchObject({
		valid: true,
		code: "VALID",
		license: {
			id: issued.data.id,
			group: null,
			user: null,
			metadata: { purpose: "auth-token", nested: { visible: true } },
			meters: [{ value: "1", limit: "1" }],
		},
	});
	expect(JSON.stringify(result)).not.toContain(issued.credential);
	expect(JSON.stringify(result)).not.toContain("keyHash");
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { requests: "1" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.valid,
	).toBe(true);
});

test("expected groups match nullable associations exactly", async () => {
	const issued = await active();
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, expectedGroupId: null },
				context.operation(),
			)
		).data.valid,
	).toBe(true);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential, expectedGroupId: Bun.randomUUIDv7() },
				context.operation(),
			)
		).data.code,
	).toBe("GROUP_NOT_ALLOWED");
});

test("disabled reason and expired/unknown decisions retain a consistent data contract", async () => {
	const issued = await active();
	await context.licenses.disable(
		{ ids: [issued.data.id], reason: "Owner requested suspension" },
		context.operation(),
	);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data,
	).toMatchObject({
		valid: false,
		code: "LICENSE_DISABLED",
		reason: "Owner requested suspension",
		license: { id: issued.data.id },
	});
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { expiresAt: "2020-01-01T00:00:00.000Z" },
		},
		context.operation(),
	);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.code,
	).toBe("LICENSE_EXPIRED");
	expect(
		(
			await context.validation.validate(
				{ license: "not-an-issued-key" },
				context.operation(),
			)
		).data,
	).toMatchObject({ valid: false, code: "LICENSE_INVALID", license: null });
});

test("competing final-unit consumption commits one balance and ledger operation", async () => {
	const issued = await active();
	const results = await Promise.allSettled(
		Array.from({ length: 10 }, () =>
			context.licenses.consume(
				{ licenseId: issued.data.id, usage: { requests: "1" } },
				context.operation(),
			),
		),
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("1");
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, issued.data.id)),
	).toHaveLength(1);
});

test("concurrent duplicate consumption returns one original and durable replay receipts", async () => {
	const issued = await active("10");
	const operation = context.operation();
	const input = { licenseId: issued.data.id, usage: { requests: "2" } };
	const results = await Promise.all(
		Array.from({ length: 8 }, () => context.licenses.consume(input, operation)),
	);
	expect(new Set(results.map((result) => result.data.id)).size).toBe(1);
	expect(results.filter((result) => !result.data.replayed)).toHaveLength(1);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("2");
	await expect(
		context.licenses.consume({ ...input, usage: { requests: "3" } }, operation),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});

test("one denied counter rolls back every balance, audit, ledger and receipt", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "a", limit: "5" },
					{ name: "b", limit: "0" },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { a: "1", b: "1" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		).every((row) => row.value === "0"),
	).toBe(true);
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, issued.data.id)),
	).toHaveLength(0);
});

test("exact decimal accumulation reaches its cap; unlimited counters still track usage", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "decimal",
						limit: "0.3",
						numericMode: "decimal",
						precision: 1,
					},
					{ name: "unlimited", limit: null },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	for (let i = 0; i < 3; i++)
		await context.licenses.consume(
			{ licenseId: issued.data.id, usage: { decimal: "0.1", unlimited: "1" } },
			context.operation(),
		);
	const rows = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(rows.find((row) => row.name === "decimal")?.value).toBe("0.3");
	expect(rows.find((row) => row.name === "unlimited")?.value).toBe("3");
	await expect(
		context.licenses.consume(
			{ licenseId: issued.data.id, usage: { decimal: "0.01" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	await context.licenses.consume(
		{ licenseId: issued.data.id, usage: { unlimited: "2" } },
		context.operation(),
	);
});

test("secret issuance retries do not repeat creation or store plaintext", async () => {
	const operation = context.operation();
	const issued = await context.licenses.create({}, operation);
	await expect(context.licenses.create({}, operation)).rejects.toMatchObject({
		code: "SECRET_ALREADY_ISSUED",
	});
	const stored = await context.database.orm
		.select()
		.from(receipts)
		.where(eq(receipts.key, operation.idempotencyKey ?? ""));
	expect(JSON.stringify(stored)).not.toContain(issued.credential);
	expect(stored[0]?.secretIssued).toEqual([issued.data.id]);
});

test("create and rotate regenerate only credential collisions without replacing another key", async () => {
	const first = await active();
	const second = await active();
	const generator = new KeyGenerator();
	const createdCredential = generator.license(first.data.keyFormat);
	const replacement = generator.license(first.data.keyFormat);
	const spy = spyOn(KeyGenerator.prototype, "license")
		.mockReturnValueOnce(first.credential)
		.mockReturnValueOnce(createdCredential)
		.mockReturnValueOnce(first.credential)
		.mockReturnValueOnce(second.credential)
		.mockReturnValueOnce(replacement);
	try {
		const created = await context.licenses.create({}, context.operation());
		expect(created.credential).toBe(createdCredential);
		expect(created.data.id).not.toBe(first.data.id);
		const result = await context.licenses.rotate(
			{ ids: [second.data.id] },
			context.operation(),
		);
		expect(result.data[0]?.credential).toBe(replacement);
		expect(
			(
				await context.validation.validate(
					{ license: first.credential },
					context.operation(),
				)
			).data.valid,
		).toBe(true);
		expect(
			(
				await context.validation.validate(
					{ license: second.credential },
					context.operation(),
				)
			).data.code,
		).toBe("LICENSE_INVALID");
	} finally {
		spy.mockRestore();
	}
	expect(
		await context.database.orm
			.select()
			.from(licenses)
			.where(eq(licenses.id, first.data.id)),
	).toHaveLength(1);
});
