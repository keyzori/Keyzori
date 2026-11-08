import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { meters } from "../../core/database/schema/meters";
import { usageOperations } from "../../core/database/schema/usageOperations";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function accepted() {
	const issued = await context.licenses.create(
		{ meters: { upsert: [{ name: "uses", limit: "10" }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const operation = context.operation();
	const input = { licenseId: issued.data.id, usage: { uses: "2" } };
	const original = await context.licenses.consume(input, operation);
	return { issued, operation, input, original };
}

test("accepted operation replay is distinct from validation and survives counter changes", async () => {
	const { issued, operation, input, original } = await accepted();
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { meters: { remove: ["uses"] } } },
		context.operation(),
	);
	const replay = await context.licenses.consume(input, operation);
	expect(replay.data).toEqual({ ...original.data, replayed: true });
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, issued.data.id)),
	).toHaveLength(1);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.license?.meters,
	).toEqual([]);
});

test("disabled and expired keys cannot replay accepted consumption until eligible again", async () => {
	const { issued, operation, input } = await accepted();
	await context.licenses.disable(
		{ ids: [issued.data.id], reason: "Paused" },
		context.operation(),
	);
	await expect(
		context.licenses.consume(input, operation),
	).rejects.toMatchObject({
		code: "CONFLICT",
		details: { license: "LICENSE_DISABLED" },
	});
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { expiresAt: "2020-01-01T00:00:00.000Z" },
		},
		context.operation(),
	);
	await expect(
		context.licenses.consume(input, operation),
	).rejects.toMatchObject({
		code: "CONFLICT",
		details: { license: "LICENSE_EXPIRED" },
	});
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { expiresAt: null } },
		context.operation(),
	);
	expect((await context.licenses.consume(input, operation)).data.replayed).toBe(
		true,
	);
});

test("licence credential rotation preserves stable consumption identity without accepting old validation keys", async () => {
	const { issued, operation, input } = await accepted();
	const rotated = await context.licenses.rotate(
		{ ids: [issued.data.id] },
		context.operation(),
	);
	expect(rotated.data).toHaveLength(1);
	expect((await context.licenses.consume(input, operation)).data.replayed).toBe(
		true,
	);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.code,
	).toBe("LICENSE_INVALID");
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("2");
});

test("replay checks current IP and device eligibility before returning the accepted receipt", async () => {
	const { issued, operation, input } = await accepted();
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { allowedIps: ["192.0.2.0/24"] } },
		context.operation(),
	);
	await expect(
		context.licenses.consume(input, operation),
	).rejects.toMatchObject({
		code: "CONFLICT",
		details: { license: "IP_NOT_ALLOWED" },
	});
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { allowedIps: [], deviceLimit: 0 } },
		context.operation(),
	);
	await expect(
		context.licenses.consume(input, operation),
	).rejects.toMatchObject({
		code: "CONFLICT",
		details: { license: "HARDWARE_ID_REQUIRED" },
	});
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { deviceLimit: null } },
		context.operation(),
	);
	expect((await context.licenses.consume(input, operation)).data.replayed).toBe(
		true,
	);
});

test("consumption replay requires access to both the current and original group", async () => {
	const originalGroup = await context.groups.create(
		{ name: "Original usage group" },
		context.operation(),
	);
	const currentGroup = await context.groups.create(
		{ name: "Current usage group" },
		context.operation(),
	);
	await context.groups.enable(
		{ ids: [originalGroup.data.id, currentGroup.data.id] },
		context.operation(),
	);
	const issued = await context.licenses.create(
		{
			groupId: originalGroup.data.id,
			meters: { upsert: [{ name: "uses", limit: "10" }] },
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	const api = await context.apiKeys.create(
		{ name: "Consumption owner" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: {
				scopes: ["usage:consume"],
				groupIds: [originalGroup.data.id, currentGroup.data.id],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [api.data.id] }, context.operation());
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${api.credential}`),
	};
	const input = { licenseId: issued.data.id, usage: { uses: "2" } };
	const accepted = await context.licenses.consume(input, operation);
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { groupId: currentGroup.data.id } },
		context.operation(),
	);
	for (const groupId of [currentGroup.data.id, originalGroup.data.id]) {
		await context.apiKeys.update(
			{ ids: [api.data.id], changes: { groupIds: [groupId] } },
			context.operation(),
		);
		operation.principal = await context.auth.authenticate(
			`Bearer ${api.credential}`,
		);
		await expect(
			context.licenses.consume(input, operation),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	}
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: { groupIds: [originalGroup.data.id, currentGroup.data.id] },
		},
		context.operation(),
	);
	operation.principal = await context.auth.authenticate(
		`Bearer ${api.credential}`,
	);
	expect((await context.licenses.consume(input, operation)).data).toEqual({
		...accepted.data,
		replayed: true,
	});
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, issued.data.id)),
	).toHaveLength(1);
	expect(
		(
			await context.database.orm
				.select()
				.from(meters)
				.where(eq(meters.licenseId, issued.data.id))
		)[0]?.value,
	).toBe("2");
});
