import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { NoopLogger, type Logger } from "drizzle-orm/logger";
import { TestContext } from "../fixtures/TestContext";
import { licenses } from "../../core/database/schema/licenses";
import { audits } from "../../core/database/schema/audits";
import {
	activityEvents,
	eventResources,
} from "../../core/database/schema/events";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { ActivityService } from "../../plugins/activity/ActivityService";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function boundedCascade(work: () => Promise<unknown>) {
	const statements: string[] = [];
	const logger: Logger = NoopLogger.prototype;
	const observe = spyOn(logger, "logQuery").mockImplementation((query) => {
		statements.push(query);
	});
	try {
		await work();
	} finally {
		observe.mockRestore();
	}
	// Allow fixed transaction overhead and batch-size tuning; reject per-child round trips.
	expect(statements.length).toBeLessThan(100);
	const children = statements.find(
		(statement) =>
			statement.includes('from "licenses"') && statement.includes("for update"),
	);
	expect(children).toBeDefined();
	for (const column of ["metadata", "notes", "key_hash", "allowed_ips"])
		expect(children).not.toContain(`"${column}"`);
}

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

test.each(["groupId", "userId"] as const)(
	"an enabled licence must be disabled before leaving a disabled %s; mixed changes roll back",
	async (field) => {
		const { group, user, issued } = await linked();
		const target = field === "groupId" ? group : user;
		const service = field === "groupId" ? context.groups : context.users;
		await service.disable({ ids: [target.data.id] }, context.operation());
		const other = await linked();
		const change = {
			ids: [other.issued.data.id, issued.data.id],
			changes: { [field]: null },
		};
		await expect(
			context.licenses.update(change, context.operation()),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const [untouched] = await context.database.orm
			.select()
			.from(licenses)
			.where(eq(licenses.id, other.issued.data.id));
		expect(untouched?.[field]).toBe(
			field === "groupId" ? other.group.data.id : other.user.data.id,
		);
		await context.licenses.disable(
			{ ids: [issued.data.id] },
			context.operation(),
		);
		await context.licenses.update(
			{ ids: [issued.data.id], changes: { [field]: null } },
			context.operation(),
		);
		expect(
			(
				await context.validation.validate(
					{ license: issued.credential },
					context.operation(),
				)
			).data.code,
		).toBe("LICENSE_DISABLED");
	},
);

test("bounded cascades preserve per-child evidence and the event sequence for each operation", async () => {
	const group = (
		await context.groups.create({ name: "Cascade" }, context.operation())
	).data.id;
	const user = (
		await context.users.create({ name: "Cascade" }, context.operation())
	).data.id;
	const children = Array.from({ length: 1001 }, () => Bun.randomUUIDv7());
	const check = children[0];
	if (!check) throw new Error("Missing revision fixture");
	await context.database.orm
		.insert(eventResources)
		.values({ type: "license", id: check, revision: 9007199254740993n });
	const keepReason = "Prior suspension";
	for (let offset = 0; offset < children.length; offset += 200)
		await context.database.orm.insert(licenses).values(
			children.slice(offset, offset + 200).map((id) => ({
				id,
				keyHash: id,
				keyFormat: KeyGenerator.defaultFormat,
				groupId: group,
				userId: user,
				disabledReason: keepReason,
				createdBy: "root",
				updatedBy: "root",
			})),
		);
	const remove = (id: string) => ({
		ids: [id],
		confirm: true as const,
		reason: "Audited retirement",
	});
	for (const [service, id] of [
		[context.groups, group],
		[context.users, user],
	] as const)
		await expect(
			service.remove(remove(id), context.operation()),
		).rejects.toMatchObject({ code: "CONFLICT" });
	const count = async (where: ReturnType<typeof eq>) =>
		(
			await context.database.orm
				.select({ n: sql<number>`count(*)::int` })
				.from(licenses)
				.where(where)
		)[0]?.n;
	expect(await count(eq(licenses.groupId, group))).toBe(1001);
	const first = children[0];
	if (!first) throw new Error("Missing first child");
	const api = await context.apiKeys.create(
		{ name: "Historical source reader" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: {
				scopes: ["audits:read", "groups:delete", "licenses:disable"],
				groupIds: [group],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [api.data.id] }, context.operation());
	const principal = await context.auth.authenticate(`Bearer ${api.credential}`);
	const scoped = { ...context.operation(), principal };
	const preparation = {
		groupId: group.toUpperCase(),
		ids: [first],
		reason: "Batch preparation",
	};
	const result = await context.groups.detachLicenses(preparation, scoped);
	await expect(
		context.groups.detachLicenses({ ...preparation, groupId: group }, scoped),
	).rejects.toMatchObject({ result });
	const deletion = context.operation();
	await boundedCascade(() => context.groups.remove(remove(group), deletion));
	expect(await count(eq(licenses.userId, user))).toBe(1001);
	const detached = await context.database.orm
		.select({
			enabled: licenses.enabled,
			group: licenses.groupId,
			reason: licenses.disabledReason,
		})
		.from(licenses)
		.where(eq(licenses.userId, user));
	expect(
		detached.every(
			(row) => !row.enabled && row.group === null && row.reason === keepReason,
		),
	).toBe(true);
	const history = await context.database.orm
		.select()
		.from(audits)
		.where(
			and(
				eq(audits.targetType, "license"),
				inArray(audits.requestId, [deletion.requestId, scoped.requestId]),
			),
		);
	expect(history).toHaveLength(1001);
	expect(
		history.every(
			(audit) =>
				audit.requiresAllGroups &&
				audit.groupId === group &&
				audit.requiredGroupIds.includes(group),
		),
	).toBe(true);
	const activity = new ActivityService(
		context.database,
		context.auth,
		context.redis,
	);
	try {
		for (const action of ["license.group_deleted", "license.group_detached"]) {
			const record = history.find((row) => row.action === action);
			if (!record) throw new Error("Missing child history");
			const query = new URLSearchParams({ id: record.id });
			expect((await activity.history(query, scoped)).data).toHaveLength(0);
			expect(
				(await activity.history(query, context.operation())).data,
			).toHaveLength(1);
		}
	} finally {
		activity.stop();
	}
	const revisions = async () =>
		await context.database.orm
			.select({
				event: activityEvents.event,
				revision: sql<string>`${activityEvents.resourceRevision}::text`,
				group: activityEvents.groupId,
			})
			.from(activityEvents)
			.where(eq(activityEvents.resourceId, check))
			.orderBy(asc(activityEvents.ordinal));
	expect(await revisions()).toEqual([
		{ event: "license.group_detached", revision: "9007199254740994", group },
		{ event: "license.disabled", revision: "9007199254740995", group },
	]);
	// An implicit group deletion emits one licence invalidation per child.
	// Explicit preparation also emits its own group-detached notification.
	const [total] = await context.database.orm
		.select({ n: sql<number>`count(*)::int` })
		.from(activityEvents)
		.where(
			and(
				eq(activityEvents.groupId, group),
				eq(activityEvents.event, "license.disabled"),
			),
		);
	const [explicit] = await context.database.orm
		.select({ n: sql<number>`count(*)::int` })
		.from(activityEvents)
		.where(
			and(
				eq(activityEvents.groupId, group),
				eq(activityEvents.event, "license.group_detached"),
			),
		);
	expect(total?.n).toBe(1001);
	expect(explicit?.n).toBe(1);
	await context.licenses.delete(remove(first), context.operation());
	const cleanup = context.operation();
	await boundedCascade(() => context.users.remove(remove(user), cleanup));
	expect(await count(eq(licenses.userId, user))).toBe(0);
	expect((await revisions()).at(-1)).toEqual({
		event: "license.deleted",
		revision: "9007199254740996",
		group: null,
	});
	expect(
		(
			await context.database.orm
				.select({ n: sql<number>`count(*)::int` })
				.from(audits)
				.where(
					and(
						eq(audits.requestId, cleanup.requestId),
						eq(audits.action, "license.deleted"),
					),
				)
		)[0]?.n,
	).toBe(1000);
}, 30000);

test("foreign licence row locks do not delay an invisible single or mixed bulk request", async () => {
	const own = await linked(),
		other = await linked();
	const api = await context.apiKeys.create(
		{ name: "Scoped disabler" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: { groupIds: [own.group.data.id], scopes: ["licenses:disable"] },
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [api.data.id] }, context.operation());
	const principal = await context.auth.authenticate(`Bearer ${api.credential}`);
	const acquired = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const blocker = context.database.orm.transaction(async (tx) => {
		await tx
			.select({ id: licenses.id })
			.from(licenses)
			.where(eq(licenses.id, other.issued.data.id))
			.for("update");
		acquired.resolve();
		await release.promise;
	});
	await acquired.promise;
	try {
		for (const ids of [
			[Bun.randomUUIDv7()],
			[other.issued.data.id],
			[own.issued.data.id, other.issued.data.id],
		])
			await expect(
				context.licenses.disable(
					{ ids },
					{ ...context.operation(), principal, deadlineAt: Date.now() + 1500 },
				),
			).rejects.toMatchObject({
				code: ids.length === 1 ? "NOT_FOUND" : "BULK_OPERATION_FAILED",
			});
	} finally {
		release.resolve();
		await blocker;
	}
	const [row] = await context.database.orm
		.select({ enabled: licenses.enabled })
		.from(licenses)
		.where(eq(licenses.id, own.issued.data.id));
	expect(row?.enabled).toBe(true);
});

test("failure allocating a later cascade revision rolls back earlier child chunks and the parent", async () => {
	const groupId = (
		await context.groups.create({ name: "Atomic cascade" }, context.operation())
	).data.id;
	const ids = Array.from({ length: 101 }, () => Bun.randomUUIDv7()).sort();
	const last = ids.at(-1);
	if (!last) throw new Error("Missing rollback fixture");
	await context.database.orm.insert(licenses).values(
		ids.map((id) => ({
			id,
			keyHash: id,
			groupId,
			keyFormat: KeyGenerator.defaultFormat,
			enabled: true,
			createdBy: "root",
			updatedBy: "root",
		})),
	);
	// A revision cannot wrap or be reused. Force a DB error in the second chunk.
	await context.database.orm
		.insert(eventResources)
		.values({ type: "license", id: last, revision: 9223372036854775807n });
	const operation = context.operation();
	await expect(
		context.groups.remove(
			{ ids: [groupId], confirm: true, reason: "Atomic retirement" },
			operation,
		),
	).rejects.toThrow();
	expect(
		await context.database.orm
			.select({ id: licenses.id })
			.from(licenses)
			.where(and(eq(licenses.groupId, groupId), eq(licenses.enabled, true))),
	).toHaveLength(101);
	expect(
		await context.database.orm
			.select({ id: audits.id })
			.from(audits)
			.where(eq(audits.requestId, operation.requestId)),
	).toHaveLength(0);
	expect(
		await context.database.orm
			.select({ id: activityEvents.id })
			.from(activityEvents)
			.where(inArray(activityEvents.resourceId, ids)),
	).toHaveLength(0);
	expect(
		await context.database.orm
			.select({ id: eventResources.id })
			.from(eventResources)
			.where(inArray(eventResources.id, ids)),
	).toEqual([{ id: last }]);
});

test("a scoped user attachment retains its qualifying association until the new link commits", async () => {
	const subject = await linked();
	const api = await context.apiKeys.create(
		{ name: "Group issuer" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: {
				groupIds: [subject.group.data.id],
				scopes: ["licenses:create", "users:read"],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [api.data.id] }, context.operation());
	const principal = await context.auth.authenticate(`Bearer ${api.credential}`);
	const reached = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const emit = context.events.emitChecked.bind(context.events);
	const hook = spyOn(context.events, "emitChecked").mockImplementationOnce(
		async (...args) => {
			const event = await emit(...args);
			reached.resolve();
			await release.promise;
			return event;
		},
	);
	const adding = context.licenses.create(
		{ groupId: subject.group.data.id, userId: subject.user.data.id },
		{ ...context.operation(), principal },
	);
	try {
		await Promise.race([reached.promise, adding]);
		await expect(
			context.licenses.update(
				{ ids: [subject.issued.data.id], changes: { userId: null } },
				{ ...context.operation(), deadlineAt: Date.now() + 250 },
			),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	} finally {
		release.resolve();
		hook.mockRestore();
	}
	const added = await adding;
	await context.licenses.update(
		{ ids: [subject.issued.data.id], changes: { userId: null } },
		context.operation(),
	);
	const [row] = await context.database.orm
		.select({ userId: licenses.userId })
		.from(licenses)
		.where(eq(licenses.id, added.data.id));
	expect(row?.userId).toBe(subject.user.data.id);
});
