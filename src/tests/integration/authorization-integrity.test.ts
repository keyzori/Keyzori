import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { LicenseView } from "../../plugins/licenses/LicenseView";
import { UsageHistory } from "../../plugins/licenses/UsageHistory";
import { licenses } from "../../core/database/schema/licenses";
import { ips } from "../../core/database/schema/ips";
import { audits } from "../../core/database/schema/audits";
import type { $Scope } from "../../core/auth/scopes";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function scoped(scopes: $Scope[], groupIds: string[]) {
	const key = await context.apiKeys.create(
		{ name: "Integrity test" },
		context.operation(),
	);
	await context.apiKeys.update(
		{ ids: [key.data.id], changes: { scopes, groupIds } },
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
	return {
		key,
		operation: {
			...context.operation(),
			principal: await context.auth.authenticate(`Bearer ${key.credential}`),
		},
	};
}

test("validation exposes registrations and metadata but excludes all administrative notes", async () => {
	const group = await context.groups.create(
		{ name: "Group", notes: "GROUP PRIVATE", metadata: { group: true } },
		context.operation(),
	);
	const user = await context.users.create(
		{ name: "User", notes: "USER PRIVATE", metadata: { user: true } },
		context.operation(),
	);
	const key = await context.licenses.create(
		{
			groupId: group.data.id,
			userId: user.data.id,
			notes: "KEY PRIVATE",
			metadata: { key: true },
		},
		context.operation(),
	);
	await context.licenses.register(
		{ licenseId: key.data.id, hardwareId: "device-public" },
		context.operation(),
		"device",
	);
	await context.licenses.register(
		{ licenseId: key.data.id, ip: "127.0.0.1" },
		context.operation(),
		"ip",
	);
	await context.licenses.disable(
		{ ids: [key.data.id], reason: "Account review" },
		context.operation(),
	);
	const result = await context.validation.validate(
		{ license: key.credential },
		context.operation(),
	);
	expect(result.data.valid).toBe(false);
	expect(result.data.reason).toBe("Account review");
	expect(result.data.license).toMatchObject({
		metadata: { key: true },
		hardwareIds: ["device-public"],
		registeredIps: ["127.0.0.1"],
	});
	const serialized = JSON.stringify(result);
	for (const secretNote of ["GROUP PRIVATE", "USER PRIVATE", "KEY PRIVATE"])
		expect(serialized).not.toContain(secretNote);
	expect(result.data.license && "notes" in result.data.license).toBe(false);
	expect(
		result.data.license?.group && "notes" in result.data.license.group,
	).toBe(false);
	expect(result.data.license?.user && "notes" in result.data.license.user).toBe(
		false,
	);
	const administrative = await context.licenses.read(
		new URLSearchParams({ id: key.data.id }),
		context.operation(),
	);
	expect(administrative.data).toMatchObject({
		notes: "KEY PRIVATE",
		group: { notes: "GROUP PRIVATE" },
		user: { notes: "USER PRIVATE" },
	});
});

test("transfer audit requires both historical groups, including before values", async () => {
	const a = await context.groups.create(
		{ name: "Source" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Destination" },
		context.operation(),
	);
	const key = await context.licenses.create(
		{ groupId: a.data.id, notes: "SOURCE ONLY", metadata: { source: true } },
		context.operation(),
	);
	await context.licenses.update(
		{
			ids: [key.data.id],
			changes: {
				groupId: b.data.id,
				notes: "DESTINATION ONLY",
				metadata: { destination: true },
			},
		},
		context.operation(),
	);
	const [record] = await context.database.orm
		.select()
		.from(audits)
		.where(
			and(
				eq(audits.targetId, key.data.id),
				eq(audits.action, "license.updated"),
			),
		);
	if (!record) throw new Error("Missing transfer evidence");
	expect(record.requiredGroupIds).toEqual([a.data.id, b.data.id]);
	const activity = new ActivityService(
		context.database,
		context.auth,
		context.redis,
	);
	try {
		for (const groupIds of [[a.data.id], [b.data.id]]) {
			const reader = await scoped(["audits:read"], groupIds);
			const page = await activity.history(
				new URLSearchParams({ id: record.id }),
				reader.operation,
			);
			expect(page.data).toEqual([]);
		}
		const both = await scoped(["audits:read"], [a.data.id, b.data.id]);
		const page = await activity.history(
			new URLSearchParams({ id: record.id }),
			both.operation,
		);
		expect(page.data).toHaveLength(1);
		expect(page.data[0]).toMatchObject({
			before: { notes: "SOURCE ONLY" },
			after: { notes: "DESTINATION ONLY" },
		});
	} finally {
		activity.stop();
	}
});

test("detail authorization and child projection cannot straddle a transfer", async () => {
	const a = await context.groups.create(
		{ name: "Read source" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Read destination" },
		context.operation(),
	);
	const key = await context.licenses.create(
		{ groupId: a.data.id },
		context.operation(),
	);
	const reader = await scoped(["licenses:read"], [a.data.id]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = LicenseView.prototype.read;
	LicenseView.prototype.read = async function (tx, row, now) {
		if (row.id === key.data.id) {
			entered.resolve();
			await release.promise;
		}
		return original.call(this, tx, row, now);
	};
	const pending = context.licenses.read(
		new URLSearchParams({ id: key.data.id }),
		reader.operation,
	);
	try {
		await entered.promise;
		await expect(
			context.database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '100ms'`);
				await tx
					.update(licenses)
					.set({ groupId: b.data.id })
					.where(eq(licenses.id, key.data.id));
				await tx.insert(ips).values({
					id: Bun.randomUUIDv7(),
					licenseId: key.data.id,
					ip: "192.0.2.25",
				});
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	} finally {
		release.resolve();
		LicenseView.prototype.read = original;
	}
	expect((await pending).data).toMatchObject({
		groupId: a.data.id,
		registeredIps: [],
	});
});

test("deletion retries recover committed results and still enforce current permissions", async () => {
	const group = await context.groups.create(
		{ name: "Delete scope" },
		context.operation(),
	);
	const key = await context.licenses.create(
		{ groupId: group.data.id },
		context.operation(),
	);
	const caller = await scoped(["licenses:delete"], [group.data.id]);
	const input = {
		ids: [key.data.id],
		confirm: true as const,
		reason: "Requested deletion",
	};
	const result = await context.licenses.delete(input, caller.operation);
	await expect(
		context.licenses.delete(input, caller.operation),
	).rejects.toMatchObject({ result });
	await context.apiKeys.update(
		{ ids: [caller.key.data.id], changes: { scopes: [] } },
		context.operation(),
	);
	await expect(
		context.licenses.delete(input, caller.operation),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const operation = context.operation();
	const deletion = {
		ids: [group.data.id],
		confirm: true as const,
		reason: "Group deletion",
	};
	const removed = await context.groups.remove(deletion, operation);
	await expect(
		context.groups.remove(deletion, operation),
	).rejects.toMatchObject({ result: removed });
});

test("historical usage can be recovered after disable and deletion without charging", async () => {
	const key = await context.licenses.create(
		{
			meters: {
				upsert: [
					{
						name: "requests",
						limit: "2",
						numericMode: "integer",
						precision: 0,
					},
				],
			},
		},
		context.operation(),
	);
	await context.licenses.enable({ ids: [key.data.id] }, context.operation());
	const operation = context.operation();
	const input = { licenseId: key.data.id, usage: { requests: "1" } };
	await expect(
		context.licenses.consume(
			{ ...input, expectedGroupId: Bun.randomUUIDv7() },
			operation,
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	const accepted = await context.licenses.consume(input, operation);
	await context.licenses.disable({ ids: [key.data.id] }, context.operation());
	await expect(
		context.licenses.consume(input, operation),
	).rejects.toMatchObject({ code: "CONFLICT" });
	const history = new UsageHistory(context.database, context.auth);
	expect((await history.lookup(key.data.id, operation)).data).toMatchObject({
		id: accepted.data.id,
		historical: true,
		outcome: "accepted",
		entries: accepted.data.entries,
	});
	await context.licenses.delete(
		{ ids: [key.data.id], confirm: true, reason: "Retired" },
		context.operation(),
	);
	expect(
		(await history.read(accepted.data.id, context.operation())).data.entries,
	).toEqual(accepted.data.entries);
});

test("group deletion preparation always disables the explicitly detached keys", async () => {
	const group = await context.groups.create(
		{ name: "Retiring" },
		context.operation(),
	);
	const key = await context.licenses.create(
		{ groupId: group.data.id },
		context.operation(),
	);
	await context.licenses.enable({ ids: [key.data.id] }, context.operation());
	const caller = await scoped(
		["groups:delete", "licenses:disable"],
		[group.data.id],
	);
	await context.groups.detachLicenses(
		{ groupId: group.data.id, ids: [key.data.id], reason: "Retiring group" },
		caller.operation,
	);
	const [row] = await context.database.orm
		.select()
		.from(licenses)
		.where(eq(licenses.id, key.data.id));
	expect(row).toMatchObject({ enabled: false, groupId: null });
	expect(
		(
			await context.validation.validate(
				{ license: key.credential },
				context.operation(),
			)
		).data.valid,
	).toBe(false);
});
