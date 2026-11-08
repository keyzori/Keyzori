import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { licenses } from "../../core/database/schema/licenses";
import { audits } from "../../core/database/schema/audits";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function linked() {
	const group = await context.groups.create(
		{ name: "Authentication", metadata: { purpose: "tokens" } },
		context.operation(),
	);
	const user = await context.users.create(
		{ name: "Developer account", metadata: { externalId: "abc" } },
		context.operation(),
	);
	await context.groups.enable({ ids: [group.data.id] }, context.operation());
	await context.users.enable({ ids: [user.data.id] }, context.operation());
	const issued = await context.licenses.create(
		{ groupId: group.data.id, userId: user.data.id },
		context.operation(),
	);
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	return { group, user, issued };
}

test("neutral groups and users start disabled; names and typed metadata remain exact", async () => {
	const first = await context.groups.create(
		{ name: "  Tokens  ", metadata: { amount: 7, externalId: "007" } },
		context.operation(),
	);
	const duplicate = await context.groups.create(
		{ name: "  Tokens  " },
		context.operation(),
	);
	expect(first.data).toMatchObject({
		name: "  Tokens  ",
		enabled: false,
		metadata: { amount: 7, externalId: "007" },
	});
	expect(first.data.id).not.toBe(duplicate.data.id);
});

test("group disable and re-enable preserve each key's own eligibility", async () => {
	const { group, user, issued } = await linked();
	const validate = () =>
		context.validation.validate(
			{ license: issued.credential, expectedGroupId: group.data.id },
			context.operation(),
		);
	expect((await validate()).data.license).toMatchObject({
		group: { id: group.data.id, metadata: { purpose: "tokens" } },
		user: { id: user.data.id, metadata: { externalId: "abc" } },
	});
	await context.groups.disable(
		{ ids: [group.data.id], disabledReason: "Group paused" },
		context.operation(),
	);
	expect((await validate()).data).toMatchObject({
		code: "GROUP_DISABLED",
		reason: "Group paused",
	});
	await context.licenses.disable(
		{ ids: [issued.data.id], reason: "Individual key paused" },
		context.operation(),
	);
	await context.groups.enable({ ids: [group.data.id] }, context.operation());
	expect((await validate()).data).toMatchObject({
		code: "LICENSE_DISABLED",
		reason: "Individual key paused",
	});
	await context.licenses.enable({ ids: [issued.data.id] }, context.operation());
	expect((await validate()).data.valid).toBe(true);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: { expiresAt: "2020-01-01T00:00:00.000Z" },
		},
		context.operation(),
	);
	await context.groups.disable({ ids: [group.data.id] }, context.operation());
	await context.groups.enable({ ids: [group.data.id] }, context.operation());
	expect((await validate()).data.code).toBe("LICENSE_EXPIRED");
});

test("deleting a group disables and detaches keys while preserving user and history", async () => {
	const { group, user, issued } = await linked();
	await context.groups.remove(
		{ ids: [group.data.id], confirm: true, reason: "Retire group" },
		context.operation(),
	);
	const [row] = await context.database.orm
		.select()
		.from(licenses)
		.where(eq(licenses.id, issued.data.id));
	expect(row).toMatchObject({
		groupId: null,
		userId: user.data.id,
		enabled: false,
		disabledReason: "Associated group was deleted",
	});
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.code,
	).toBe("LICENSE_DISABLED");
	const evidence = await context.database.orm
		.select()
		.from(audits)
		.where(
			and(
				eq(audits.targetId, issued.data.id),
				eq(audits.action, "license.group_deleted"),
			),
		);
	expect(evidence[0]?.groupId).toBe(group.data.id);
	expect(
		(
			await context.users.read(
				new URLSearchParams({ id: user.data.id }),
				context.operation(),
			)
		).data,
	).toMatchObject({ id: user.data.id });
});

test("deleting a user deletes associated keys and retains immutable audit evidence", async () => {
	const { user, issued } = await linked();
	await context.users.remove(
		{ ids: [user.data.id], confirm: true, reason: "Remove account" },
		context.operation(),
	);
	expect(
		await context.database.orm
			.select()
			.from(licenses)
			.where(eq(licenses.id, issued.data.id)),
	).toHaveLength(0);
	expect(
		(
			await context.validation.validate(
				{ license: issued.credential },
				context.operation(),
			)
		).data.code,
	).toBe("LICENSE_INVALID");
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(
				and(
					eq(audits.targetId, issued.data.id),
					eq(audits.action, "license.deleted"),
				),
			),
	).toHaveLength(1);
});

test("bulk lifecycle errors roll back every valid target and no-op updates add no history", async () => {
	const group = await context.groups.create(
		{ name: "No-op" },
		context.operation(),
	);
	const before = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, group.data.id));
	await context.groups.update(
		{ ids: [group.data.id], changes: { name: "No-op" } },
		context.operation(),
	);
	await context.groups.disable({ ids: [group.data.id] }, context.operation());
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, group.data.id)),
	).toHaveLength(before.length);
	await expect(
		context.groups.enable(
			{ ids: [group.data.id, Bun.randomUUIDv7()] },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "BULK_OPERATION_FAILED" });
	expect(
		(
			await context.groups.read(
				new URLSearchParams({ id: group.data.id }),
				context.operation(),
			)
		).data,
	).toMatchObject({ enabled: false });
});

test("selected group grants cannot read or reassign keys across group boundaries", async () => {
	const a = await linked();
	const b = await linked();
	const key = await context.apiKeys.create(
		{ name: "Group A integration" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [key.data.id],
			changes: {
				scopes: [
					"licenses:read",
					"licenses:update",
					"groups:read",
					"users:read",
					"users:delete",
					"licenses:delete",
				],
				groupIds: [a.group.data.id],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
	const principal = await context.auth.authenticate(`Bearer ${key.credential}`);
	const operation = { ...context.operation(), principal };
	const listed = await context.licenses.read(new URLSearchParams(), operation);
	expect(
		Array.isArray(listed.data) && listed.data.map((row) => row.id),
	).toEqual([a.issued.data.id]);
	await expect(
		context.licenses.read(
			new URLSearchParams({ id: b.issued.data.id }),
			operation,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		context.licenses.update(
			{ ids: [a.issued.data.id], changes: { groupId: b.group.data.id } },
			{ ...operation, idempotencyKey: Bun.randomUUIDv7() },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		context.licenses.update(
			{ ids: [a.issued.data.id], changes: { groupId: null } },
			{ ...operation, idempotencyKey: Bun.randomUUIDv7() },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		context.licenses.update(
			{ ids: [a.issued.data.id], changes: { userId: b.user.data.id } },
			{ ...operation, idempotencyKey: Bun.randomUUIDv7() },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		context.users.remove(
			{
				ids: [a.user.data.id],
				confirm: true,
				reason: "Forbidden global mutation",
			},
			{ ...operation, idempotencyKey: Bun.randomUUIDv7() },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
