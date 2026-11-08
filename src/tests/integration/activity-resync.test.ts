import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestContext } from "../fixtures/TestContext";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { HttpError } from "../../core/http/HttpError";
import type { $LicenseAdmin } from "../../types/licenses";
import type { $PublishedEvent } from "../../types/webhooks";

const context = new TestContext();
const activity = new ActivityService(
	context.database,
	context.auth,
	context.redis,
);
beforeAll(async () => {
	await context.start();
	await activity.publish();
});
afterAll(async () => {
	activity.stop();
	await context.stop();
});

test("non-atomic pagination plus invalidation/refetch converges through create, reassign and delete", async () => {
	const a = await context.groups.create(
		{ name: "Resync A" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Resync B" },
		context.operation(),
	);
	// The newly visible key sorts BEFORE the first page cursor, so ordinary list
	// pagination alone would miss it after the transfer.
	const incoming = await context.licenses.create(
		{ groupId: b.data.id },
		context.operation(),
	);
	const leaving = await context.licenses.create(
		{ groupId: a.data.id },
		context.operation(),
	);
	const deleted = await context.licenses.create(
		{ groupId: a.data.id },
		context.operation(),
	);
	const updated = await context.licenses.create(
		{ groupId: a.data.id, metadata: { value: "old" } },
		context.operation(),
	);
	const key = await context.apiKeys.create(
		{ name: "Resync reader" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [key.data.id],
			changes: {
				scopes: ["licenses:read", "events:read"],
				groupIds: [a.data.id],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${key.credential}`),
	};
	await activity.publish(1000);
	const watermark = (await activity.watermark(operation)).data;
	expect(watermark.stateConsistency).toBe("non-atomic");
	const cache = new Map<string, $LicenseAdmin>();
	let reads = 0;
	async function refetch(id: string) {
		reads++;
		try {
			const result = await context.licenses.read(
				new URLSearchParams({ id }),
				operation,
			);
			if (Array.isArray(result.data))
				throw new Error("Expected authorized detail");
			cache.set(id, result.data);
		} catch (error) {
			if (!(error instanceof HttpError) || error.code !== "NOT_FOUND")
				throw error;
			cache.delete(id);
		}
	}
	const first = await context.licenses.read(
		new URLSearchParams({ limit: "1", sort: "createdAt", direction: "asc" }),
		operation,
	);
	if (!Array.isArray(first.data) || !first.nextCursor)
		throw new Error("Expected first list page");
	expect(first.data.map((row) => row.id)).toEqual([leaving.data.id]);
	await refetch(leaving.data.id);
	const created = await context.licenses.create(
		{ groupId: a.data.id },
		context.operation(),
	);
	await context.licenses.update(
		{ ids: [leaving.data.id], changes: { groupId: b.data.id } },
		context.operation(),
	);
	await context.licenses.update(
		{ ids: [incoming.data.id], changes: { groupId: a.data.id } },
		context.operation(),
	);
	await context.licenses.delete(
		{ ids: [deleted.data.id], confirm: true, reason: "Resync deletion" },
		context.operation(),
	);
	await context.licenses.update(
		{ ids: [updated.data.id], changes: { metadata: { value: "new" } } },
		context.operation(),
	);
	let pageCursor: string | null = first.nextCursor;
	while (pageCursor) {
		const page = await context.licenses.read(
			new URLSearchParams({
				limit: "1",
				sort: "createdAt",
				direction: "asc",
				cursor: pageCursor,
			}),
			operation,
		);
		if (!Array.isArray(page.data)) throw new Error("Expected collection page");
		for (const row of page.data) await refetch(row.id);
		pageCursor = page.nextCursor ?? null;
	}
	expect(cache.has(incoming.data.id)).toBe(false);
	expect(cache.has(leaving.data.id)).toBe(true);
	await context.licenses.update(
		{ ids: [updated.data.id], changes: { metadata: { value: "newest" } } },
		context.operation(),
	);
	// All these commits were invisible to the publication watermark until now.
	await activity.publish(1000);
	const processed = new Map<string, bigint>();
	async function invalidate(event: $PublishedEvent) {
		if (event.resource.type !== "license") return;
		const revision = BigInt(event.resource.revision);
		if ((processed.get(event.resource.id) ?? 0n) >= revision) return;
		// Serial per-resource authorized reads; historical data never overwrites it.
		await refetch(event.resource.id);
		processed.set(event.resource.id, revision);
	}
	const replayed: $PublishedEvent[] = [];
	let cursor = watermark.cursor;
	for (;;) {
		const batch = await activity.read(
			new URLSearchParams({ cursor, limit: "2" }),
			operation,
		);
		for (const event of batch.data) {
			await invalidate(event);
			replayed.push(event);
		}
		cursor = batch.cursor; // Only after every invalidation has been processed.
		if (!batch.hasMore) break;
	}
	expect([...cache.keys()].sort()).toEqual(
		[incoming.data.id, updated.data.id, created.data.id].sort(),
	);
	expect(cache.get(updated.data.id)?.metadata).toEqual({ value: "newest" });
	const beforeDuplicates = reads;
	for (const event of replayed.toReversed()) await invalidate(event);
	expect(reads).toBe(beforeDuplicates);
	expect(cache.get(updated.data.id)?.metadata).toEqual({ value: "newest" });
	expect(
		(await activity.read(new URLSearchParams({ cursor }), operation)).data,
	).toEqual([]);
});
