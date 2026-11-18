import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { audits } from "../../core/database/schema/audits";
import { activityEvents } from "../../core/database/schema/events";
import { groups } from "../../core/database/schema/groups";
import { receipts } from "../../core/database/schema/receipts";
import { Replay } from "../../core/security/Replay";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { ActivityService } from "../../plugins/activity/ActivityService";
import type { $Scope } from "../../core/auth/scopes";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

async function group(name: string) {
	return (
		await context.groups.create(
			{ name, notes: "administrative fixture" },
			context.operation(),
		)
	).data.id;
}
async function grant(scopes: $Scope[], groupIds: string[]) {
	const issued = await context.apiKeys.create(
		{ name: "Delegated receipt" },
		context.operation(),
	);
	await context.apiKeys.update(
		{ ids: [issued.data.id], changes: { scopes, groupIds } },
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [issued.data.id] }, context.operation());
	return issued;
}
async function generation(credential: string) {
	const principal = await context.auth.authenticate(`Bearer ${credential}`);
	if (principal.kind !== "api") throw new Error("Expected API principal");
	return BigInt(principal.grantGeneration);
}

test("API-key generations fence restored grants, rotation and lifecycle, but not attribution, descriptive edits or no-ops", async () => {
	const a = await group("Generation A");
	const b = await group("Generation B");
	const api = await grant(["events:read"], [a]);
	const id = api.data.id;
	const first = await generation(api.credential);
	const activity = new ActivityService(
		context.database,
		context.auth,
		context.redis,
	);
	await activity.publish();
	const reader = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${api.credential}`),
	};
	const { cursor } = (await activity.watermark(reader)).data;
	await context.database.orm
		.update(apiKeys)
		.set({ lastUsedAt: null })
		.where(eq(apiKeys.id, id));
	expect(await generation(api.credential)).toBe(first);
	await activity.read(new URLSearchParams({ cursor }), reader);
	await context.apiKeys.update(
		{
			ids: [id],
			changes: { name: "Renamed", scopes: ["events:read"], groupIds: [a] },
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [id] }, context.operation());
	expect(await generation(api.credential)).toBe(first);
	await context.apiKeys.update(
		{ ids: [id], changes: { groupIds: [b] } },
		context.operation(),
	);
	await context.apiKeys.update(
		{ ids: [id], changes: { groupIds: [a] } },
		context.operation(),
	);
	expect(await generation(api.credential)).toBe(first + 2n);
	await expect(
		activity.read(new URLSearchParams({ cursor }), reader),
	).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
	await context.apiKeys.disable({ ids: [id] }, context.operation());
	await context.apiKeys.enable({ ids: [id] }, context.operation());
	const [replacement] = (
		await context.apiKeys.rotate({ ids: [id] }, context.operation())
	).data;
	if (!replacement) throw new Error("Missing replacement credential");
	expect(await generation(replacement.credential)).toBe(first + 5n);
	await context.apiKeys.update(
		{ ids: [id], changes: { expiresAt: "2099-01-01T00:00:00.123Z" } },
		context.operation(),
	);
	expect(await generation(replacement.credential)).toBe(first + 6n);
	await expect(
		context.apiKeys.update(
			{ ids: [id], changes: { expiresAt: "2099-01-01T00:00:00.1234Z" } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("retired group grants can be kept per target but never newly assigned, including within a bulk edit", async () => {
	const retired = await group("Retired");
	const live = await group("Live");
	const holder = await grant(["audits:read"], [retired]);
	const other = await grant(["audits:read"], [live]);
	await context.groups.remove(
		{ ids: [retired], confirm: true, reason: "Fixture retirement" },
		context.operation(),
	);
	await context.apiKeys.update(
		{ ids: [holder.data.id], changes: { groupIds: [retired, live] } },
		context.operation(),
	);
	await expect(
		context.apiKeys.update(
			{
				ids: [holder.data.id, other.data.id],
				changes: { groupIds: [retired] },
			},
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	const read = async (id: string) =>
		(
			await context.apiKeys.read(
				new URLSearchParams({ id }),
				context.operation(),
			)
		).data;
	expect(await read(holder.data.id)).toMatchObject({
		groupIds: [retired, live].sort(),
	});
	expect(await read(other.data.id)).toMatchObject({ groupIds: [live] });
	await context.apiKeys.update(
		{ ids: [holder.data.id], changes: { groupIds: [live] } },
		context.operation(),
	);
	await expect(
		context.apiKeys.update(
			{ ids: [holder.data.id], changes: { groupIds: [retired, live] } },
			context.operation(),
		),
	).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

test("root listing and detail keep the key and its group assignment in the same committed snapshot", async () => {
	const a = await group("Projection A");
	const b = await group("Projection B");
	const api = await grant(["events:read"], [a]);
	const ids = [api.data.id];
	await context.apiKeys.update(
		{ ids, changes: { name: a } },
		context.operation(),
	);
	await Promise.all([
		(async () => {
			for (const groupId of [b, a, b, a, b, a])
				await context.apiKeys.update(
					{ ids, changes: { name: groupId, groupIds: [groupId] } },
					context.operation(),
				);
		})(),
		(async () => {
			for (let i = 0; i < 12; i++) {
				const query = i % 2 ? { id: api.data.id } : { search: api.data.id };
				const result = await context.apiKeys.read(
					new URLSearchParams(Object.entries(query)),
					context.operation(),
				);
				const item = Array.isArray(result.data) ? result.data[0] : result.data;
				if (!item) throw new Error("Missing API-key projection");
				expect(item.groupIds).toEqual([item.name]);
				expect(item).not.toHaveProperty("secretHash");
				expect(item).not.toHaveProperty("grantGeneration");
			}
		})(),
	]);
});

test("a projected replay survives unrelated grants and credential rotation but never restores lost read access", async () => {
	const a = await group("Mutation");
	const api = await grant(["groups:update", "groups:read", "events:read"], [a]);
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${api.credential}`),
	};
	const input = { ids: [a], changes: { name: "Changed" } };
	const original = await context.groups.update(input, operation);
	expect(original.data).toMatchObject([{ notes: "administrative fixture" }]);
	await context.apiKeys.update(
		{
			ids: [api.data.id],
			changes: { scopes: ["groups:update", "groups:read"] },
		},
		context.operation(),
	);
	await expect(context.groups.update(input, operation)).rejects.toMatchObject({
		result: original,
	});
	const [rotated] = (
		await context.apiKeys.rotate({ ids: [api.data.id] }, context.operation())
	).data;
	if (!rotated) throw new Error("No rotated API key");
	await expect(context.groups.update(input, operation)).rejects.toMatchObject({
		code: "UNAUTHORIZED",
	});
	operation.principal = await context.auth.authenticate(
		`Bearer ${rotated.credential}`,
	);
	await context.apiKeys.update(
		{ ids: [api.data.id], changes: { scopes: ["groups:update"] } },
		context.operation(),
	);
	try {
		await context.groups.update(input, operation);
		throw new Error("Expected replay");
	} catch (error) {
		if (!(error instanceof Replay)) throw error;
		expect(error.result).toEqual({ data: [{ id: a }] });
	}
	await expect(
		context.groups.update(
			{ ...input, changes: { name: "Different" } },
			operation,
		),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
	await context.apiKeys.update(
		{ ids: [api.data.id], changes: { scopes: [] } },
		context.operation(),
	);
	await expect(context.groups.update(input, operation)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
});

test("resource transfer receipts require historical groups even when the current resource is visible", async () => {
	const a = await group("Original");
	const b = await group("Destination");
	const api = await grant(["licenses:update"], [a, b]);
	const licence = await context.licenses.create(
		{ groupId: a },
		context.operation(),
	);
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${api.credential}`),
	};
	const input = { ids: [licence.data.id], changes: { groupId: b } };
	await context.licenses.update(input, operation);
	await context.apiKeys.update(
		{ ids: [api.data.id], changes: { groupIds: [b] } },
		context.operation(),
	);
	await expect(context.licenses.update(input, operation)).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
});

test("activation retries retain the original endpoint selection as well as current ownership", async () => {
	const a = await group("Original endpoint selection");
	const b = await group("Current endpoint selection");
	const api = await grant(
		[
			"events:read",
			"licenses:read",
			"webhooks:create",
			"webhooks:update",
			"webhooks:rotate-secret",
		],
		[a, b],
	);
	const principal = await context.auth.authenticate(`Bearer ${api.credential}`);
	const operation = () => ({ ...context.operation(), principal });
	const service = new WebhookService(
		context.database,
		context.auth,
		context.audit,
		context.settings,
		context.idempotency,
		{ encryptionKey: "ab".repeat(32) },
	);
	const created = await service.create(
		{
			url: "https://receiver.example/events",
			events: ["license.created"],
			groupIds: [a],
		},
		operation(),
	);
	const [staged] = (
		await service.rotateSecret({ ids: [created.data.id] }, operation())
	).data;
	if (!staged) throw new Error("Missing staged signing-key fixture");
	const activation = operation();
	const input = { id: created.data.id, signingKeyId: staged.signingKeyId };
	const acknowledged = await service.activateSecret(input, activation);
	await expect(service.activateSecret(input, activation)).rejects.toMatchObject(
		{ result: acknowledged },
	);
	const [stored] = await context.database.orm
		.select({ authority: receipts.authority })
		.from(receipts)
		.where(
			and(
				eq(receipts.operation, "webhook.activate-secret"),
				eq(receipts.principalId, api.data.id),
			),
		);
	expect(stored?.authority).toMatchObject({
		ownerId: api.data.id,
		groupIds: [a],
	});
	await service.update(
		{ ids: [created.data.id], changes: { groupIds: [b] } },
		operation(),
	);
	await context.apiKeys.update(
		{ ids: [api.data.id], changes: { groupIds: [b] } },
		context.operation(),
	);
	await expect(service.activateSecret(input, activation)).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
});

test("credential recovery IDs survive unrelated grant edits but respect the issued licence's current group", async () => {
	const a = await group("Issued");
	const b = await group("Transferred");
	const api = await grant(["licenses:create", "events:read"], [a]);
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${api.credential}`),
	};
	const body = { groupId: a };
	const issued = await context.licenses.create(body, operation);
	await context.apiKeys.update(
		{ ids: [api.data.id], changes: { scopes: ["licenses:create"] } },
		context.operation(),
	);
	await expect(context.licenses.create(body, operation)).rejects.toMatchObject({
		code: "SECRET_ALREADY_ISSUED",
		resourceIds: [issued.data.id],
	});
	await context.licenses.update(
		{ ids: [issued.data.id], changes: { groupId: b } },
		context.operation(),
	);
	await expect(context.licenses.create(body, operation)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
});

test("a malformed fresh result rolls back evidence and receipts; a live legacy receipt never runs the command", async () => {
	const id = Bun.randomUUIDv7();
	const operation = {
		...context.operation(),
		idempotencyKey: Bun.randomUUIDv7(),
	};
	const input = { ids: [id] };
	let calls = 0;
	const run = () =>
		context.idempotency.admin(operation, "group.update", input, async (tx) => {
			calls++;
			await tx.insert(groups).values({
				id,
				name: "Rollback fixture",
				createdBy: "root",
				updatedBy: "root",
			});
			await context.audit.record(tx, {
				...operation,
				actor: operation.principal,
				action: "group.updated",
				targetType: "group",
				targetId: id,
			});
			await context.events.emit(tx, "group.updated", { groupId: id });
			return { data: [{ id, credential: "forbidden fixture field" }] };
		});
	await expect(run()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
	expect(
		await context.database.orm
			.select({ id: groups.id })
			.from(groups)
			.where(eq(groups.id, id)),
	).toEqual([]);
	expect(
		await context.database.orm
			.select({ id: audits.id })
			.from(audits)
			.where(eq(audits.targetId, id)),
	).toEqual([]);
	expect(
		await context.database.orm
			.select({ id: activityEvents.id })
			.from(activityEvents)
			.where(eq(activityEvents.resourceId, id)),
	).toEqual([]);
	const identity = {
		operation: "group.update",
		principalId: "root",
		key: operation.idempotencyKey,
	};
	const where = and(
		eq(receipts.operation, identity.operation),
		eq(receipts.principalId, "root"),
		eq(receipts.key, identity.key),
	);
	expect(
		await context.database.orm.select().from(receipts).where(where),
	).toEqual([]);
	await context.database.orm.insert(receipts).values({
		...identity,
		version: 1,
		fingerprint: context.idempotency.fingerprint(input),
		result: { data: [{ id }] },
		expiresAt: new Date(Date.now() + 60000),
	});
	await expect(run()).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
	expect(calls).toBe(1);
});
