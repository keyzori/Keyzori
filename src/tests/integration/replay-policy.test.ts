import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { meters } from "../../core/database/schema/meters";
import { hardware } from "../../core/database/schema/hardware";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("accepted usage replays after precision changes, meter deletion and new device requirements", async () => {
	const issued = await context.licenses.create(
		{
			meters: {
				upsert: [
					{ name: "uses", limit: 10, numericMode: "decimal", precision: 1 },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	const input = { license: issued.credential, usage: { uses: 0.5 } };
	expect((await context.validation.validate(input, operation)).code).toBe(
		"VALID",
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				meters: {
					upsert: [{ name: "uses", limit: 10, numericMode: "integer" }],
				},
				deviceLimit: 0,
			},
		},
		context.operation(),
	);
	expect((await context.validation.validate(input, operation)).code).toBe(
		"VALID",
	);
	const [meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("0");
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { meters: { remove: ["uses"] } } },
		context.operation(),
	);
	expect((await context.validation.validate(input, operation)).code).toBe(
		"VALID",
	);
	expect(
		await context.database.orm
			.select()
			.from(hardware)
			.where(eq(hardware.licenseId, issued.data.id)),
	).toHaveLength(0);
	await expect(
		context.validation.validate(input, context.operation()),
	).rejects.toMatchObject({ code: "HARDWARE_ID_REQUIRED" });
});

test("accepted usage rechecks current IP restrictions and binds its original effective IP", async () => {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "uses", limit: 10 }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	const input = { license: issued.credential, usage: { uses: 1 } };
	expect((await context.validation.validate(input, operation)).code).toBe(
		"VALID",
	);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { allowedIps: ["192.0.2.0/24"] } },
		context.operation(),
	);
	expect((await context.validation.validate(input, operation)).code).toBe(
		"IP_NOT_ALLOWED",
	);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { allowedIps: [] } },
		context.operation(),
	);
	await expect(
		context.validation.validate(input, { ...operation, clientIp: "192.0.2.1" }),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
	expect((await context.validation.validate(input, operation)).code).toBe(
		"VALID",
	);
	const [meter] = await context.database.orm
		.select()
		.from(meters)
		.where(eq(meters.licenseId, issued.data.id));
	expect(meter?.value).toBe("1");
});
