import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, isNotNull, sql } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { resetEventEpoch } from "../../plugins/activity/EventEpoch";
import {
	activityEvents,
	eventResources,
	eventState,
} from "../../core/database/schema/events";
import { webhooks } from "../../core/database/schema/webhooks";
import { audits } from "../../core/database/schema/audits";

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

async function waitingOnLock(name: string) {
	const deadline = Date.now() + 3000;
	for (;;) {
		const [row] = await context.database.orm
			.select({
				waiting: sql<boolean>`exists(select 1 from pg_stat_activity where application_name = ${name} and wait_event_type = 'Lock')`,
			})
			.from(sql`(values (1)) as probe`);
		if (row?.waiting) return;
		if (Date.now() >= deadline)
			throw new Error("Expected transaction lock barrier");
		await Bun.sleep(10);
	}
}

test("the same resource cannot publish a later revision before an earlier producer commits", async () => {
	const cursor = (await activity.watermark(context.operation())).data.cursor;
	const licenseId = Bun.randomUUIDv7();
	const inserted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const label = `activity-revision-${Bun.randomUUIDv7()}`;
	const first = context.database.transaction(async (tx) => {
		await context.events.emit(tx, "license.created", {
			licenseId,
			groupId: null,
		});
		inserted.resolve();
		await release.promise;
	});
	await inserted.promise;
	const second = context.database.transaction(async (tx) => {
		await tx.execute(
			sql`select set_config('application_name', ${label}, true)`,
		);
		await context.events.emit(tx, "license.updated", {
			licenseId,
			groupId: null,
		});
	});
	try {
		await waitingOnLock(label);
		await activity.publish();
		expect(
			(
				await activity.read(
					new URLSearchParams({ cursor }),
					context.operation(),
				)
			).data,
		).toEqual([]);
	} finally {
		release.resolve();
		await Promise.all([first, second]);
	}
	await activity.publish();
	const events = (
		await activity.read(new URLSearchParams({ cursor }), context.operation())
	).data;
	expect(
		events.map((event) => [
			event.event,
			event.resource.id,
			event.resource.revision,
		]),
	).toEqual([
		["license.created", licenseId, "1"],
		["license.updated", licenseId, "2"],
	]);
	expect(BigInt(events[1]?.sequence ?? "0")).toBeGreaterThan(
		BigInt(events[0]?.sequence ?? "0"),
	);
});

test("a rolled-back resource revision and its outbox row both disappear", async () => {
	const licenseId = Bun.randomUUIDv7();
	await expect(
		context.database.transaction(async (tx) => {
			await context.events.emit(tx, "license.created", {
				licenseId,
				groupId: null,
			});
			throw new Error("rollback revision");
		}),
	).rejects.toThrow("rollback revision");
	expect(
		await context.database.orm
			.select()
			.from(eventResources)
			.where(eq(eventResources.id, licenseId)),
	).toEqual([]);
	const committed = await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", { licenseId, groupId: null }),
	);
	expect(committed.resource.revision).toBe("1");
});

test("watermark-before-snapshot includes commits whose outbox publication was still pending", async () => {
	await activity.publish();
	const licenseId = Bun.randomUUIDv7();
	await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", { licenseId, groupId: null }),
	);
	const snapshot = (await activity.watermark(context.operation())).data;
	expect(snapshot.protocol).toBe("invalidation-refetch");
	expect(snapshot.stateConsistency).toBe("non-atomic");
	await context.database.transaction((tx) =>
		context.events.emit(tx, "license.updated", { licenseId, groupId: null }),
	);
	await activity.publish();
	const replay = await activity.read(
		new URLSearchParams({ cursor: snapshot.cursor }),
		context.operation(),
	);
	expect(replay.data.map((event) => event.resource.revision)).toEqual([
		"1",
		"2",
	]);
	expect(replay.data.every((event) => event.epoch === snapshot.epoch)).toBe(
		true,
	);
});

test("concurrent publishers allocate one ordered sequence without double-publication", async () => {
	const cursor = (await activity.watermark(context.operation())).data.cursor;
	await context.database.transaction(async (tx) => {
		for (let i = 0; i < 12; i++)
			await context.events.emit(tx, "license.created", {
				licenseId: Bun.randomUUIDv7(),
				groupId: null,
			});
	});
	const other = new ActivityService(
		context.database,
		context.auth,
		context.redis,
	);
	const counts = await Promise.all([activity.publish(7), other.publish(7)]);
	expect(counts.reduce((sum, count) => sum + count, 0)).toBe(12);
	const result = await activity.read(
		new URLSearchParams({ cursor }),
		context.operation(),
	);
	expect(result.data).toHaveLength(12);
	expect(new Set(result.data.map((event) => event.sequence)).size).toBe(12);
	expect(new Set(result.data.map((event) => event.id)).size).toBe(12);
});

test("restore changes the epoch without rebasing publication or accepting old cursors", async () => {
	const before = (await activity.watermark(context.operation())).data;
	const reset = await activity.resetEpoch();
	expect(reset.epoch).not.toBe(before.epoch);
	expect(reset.sequence).toBe(before.sequence);
	await expect(
		activity.read(
			new URLSearchParams({ cursor: before.cursor }),
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
	const fresh = (await activity.watermark(context.operation())).data;
	await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", {
			licenseId: Bun.randomUUIDv7(),
			groupId: null,
		}),
	);
	await activity.publish();
	const replay = await activity.read(
		new URLSearchParams({ cursor: fresh.cursor }),
		context.operation(),
	);
	expect(replay.data).toHaveLength(1);
	expect(replay.data[0]?.epoch).toBe(reset.epoch);
	expect(BigInt(replay.data[0]?.sequence ?? "0")).toBe(
		BigInt(before.sequence) + 1n,
	);
});

test("an aborted restore transaction cannot rotate the epoch independently of its other work", async () => {
	const before = (await activity.watermark(context.operation())).data;
	await expect(
		context.database.transaction(async (tx) => {
			const changed = await resetEventEpoch(tx);
			expect(changed.epoch).not.toBe(before.epoch);
			throw new Error("restore audit failed");
		}, "write"),
	).rejects.toThrow("restore audit failed");
	const after = (await activity.watermark(context.operation())).data;
	expect(after).toEqual(before);
	expect(
		(
			await activity.read(
				new URLSearchParams({ cursor: before.cursor }),
				context.operation(),
			)
		).data,
	).toEqual([]);
});

test("transfer notifications expose one side while audit history requires both historical groups", async () => {
	const a = await context.groups.create(
		{ name: "Transfer A" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Transfer B" },
		context.operation(),
	);
	const license = await context.licenses.create(
		{ groupId: a.data.id, metadata: { private: "source-value" } },
		context.operation(),
	);
	async function reader(groupIds: string[], allGroups = false) {
		const key = await context.apiKeys.create(
			{ name: "Transfer reader" },
			context.operation(),
		);
		await context.apiKeys.update(
			{
				ids: [key.data.id],
				changes: {
					scopes: ["licenses:read", "events:read", "audits:read"],
					groupIds,
					allGroups,
				},
			},
			context.operation(),
		);
		await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
		return {
			...context.operation(),
			principal: await context.auth.authenticate(`Bearer ${key.credential}`),
		};
	}
	const source = await reader([a.data.id]);
	const destination = await reader([b.data.id]);
	const both = await reader([a.data.id, b.data.id]);
	const all = await reader([], true);
	await activity.publish(1000);
	const sourceCursor = (await activity.watermark(source)).data.cursor;
	const destinationCursor = (await activity.watermark(destination)).data.cursor;
	await expect(
		context.database.transaction((tx) =>
			context.events.emitChecked(tx, "license.group_detached", {
				licenseId: license.data.id,
			}),
		),
	).rejects.toThrow("Transfer event authorization context is required");
	await context.licenses.update(
		{
			ids: [license.data.id],
			changes: {
				groupId: b.data.id,
				metadata: { private: "destination-value" },
			},
		},
		context.operation(),
	);
	await activity.publish(1000);
	const from = await activity.read(
		new URLSearchParams({ cursor: sourceCursor }),
		source,
	);
	const to = await activity.read(
		new URLSearchParams({ cursor: destinationCursor }),
		destination,
	);
	expect(from.data.map((event) => [event.event, event.data])).toEqual([
		[
			"license.group_detached",
			{ licenseId: license.data.id, groupId: a.data.id },
		],
	]);
	expect(to.data.map((event) => event.event)).toEqual([
		"license.group_attached",
		"license.updated",
	]);
	expect(JSON.stringify(from.data)).not.toContain(b.data.id);
	expect(JSON.stringify(to.data)).not.toContain(a.data.id);
	expect(JSON.stringify(to.data)).not.toContain("source-value");
	const [record] = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, license.data.id))
		.orderBy(sql`${audits.createdAt} desc`, sql`${audits.id} desc`)
		.limit(1);
	if (!record) throw new Error("Missing transfer audit");
	expect(record.requiredGroupIds.slice().sort()).toEqual(
		[a.data.id, b.data.id].sort(),
	);
	for (const principal of [source, destination])
		expect(
			(
				await activity.history(
					new URLSearchParams({ id: record.id }),
					principal,
				)
			).data,
		).toEqual([]);
	for (const principal of [both, all])
		expect(
			(
				await activity.history(
					new URLSearchParams({ id: record.id }),
					principal,
				)
			).data,
		).toHaveLength(1);
	await context.licenses.update(
		{ ids: [license.data.id], changes: { groupId: null } },
		context.operation(),
	);
	const [ungrouped] = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, license.data.id))
		.orderBy(sql`${audits.createdAt} desc`, sql`${audits.id} desc`)
		.limit(1);
	if (!ungrouped) throw new Error("Missing ungrouped transfer audit");
	expect(ungrouped.requiresAllGroups).toBe(true);
	expect(
		(await activity.history(new URLSearchParams({ id: ungrouped.id }), both))
			.data,
	).toEqual([]);
	expect(
		(await activity.history(new URLSearchParams({ id: ungrouped.id }), all))
			.data,
	).toHaveLength(1);
});

test("retention is bounded, protects unpublished and un-enqueued work, expires cursors and preserves revisions", async () => {
	await activity.publish();
	const before = (await activity.watermark(context.operation())).data;
	const licenseId = Bun.randomUUIDv7();
	const published = await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", { licenseId, groupId: null }),
	);
	await activity.publish();
	const pending = await context.database.transaction((tx) =>
		context.events.emit(
			tx,
			"license.updated",
			{ licenseId, groupId: null },
			new Date("2020-01-01T00:00:00Z"),
		),
	);
	const endpoint = Bun.randomUUIDv7();
	await context.database.orm.insert(webhooks).values({
		id: endpoint,
		url: "https://example.com/events",
		events: ["license.created"],
		allGroups: true,
		enabled: true,
		secretCiphertext: "retention-fixture",
		signingKeyId: Bun.randomUUIDv7(),
		createdBy: "fixture",
		updatedBy: "fixture",
		lastSequence: 0n,
	});
	try {
		await context.database.orm
			.update(activityEvents)
			.set({ publishedAt: new Date("2020-01-01T00:00:00Z") })
			.where(isNotNull(activityEvents.sequence));
		expect(
			(await activity.prune({ retentionMs: 86400000, limit: 1 })).removed,
		).toBe(0);
		const [high] = await context.database.orm
			.select()
			.from(eventState)
			.where(eq(eventState.id, 1));
		if (!high) throw new Error("Missing state");
		await context.database.orm
			.update(webhooks)
			.set({ lastSequence: high.sequence })
			.where(eq(webhooks.id, endpoint));
		expect(
			(await activity.prune({ retentionMs: 86400000, limit: 1 })).removed,
		).toBe(1);
		for (let i = 0; i < 20; i++)
			if (!(await activity.prune({ retentionMs: 86400000, limit: 3 })).removed)
				break;
		expect(
			await context.database.orm
				.select()
				.from(activityEvents)
				.where(eq(activityEvents.id, published.id)),
		).toEqual([]);
		expect(
			await context.database.orm
				.select()
				.from(activityEvents)
				.where(eq(activityEvents.id, pending.id)),
		).toHaveLength(1);
		await expect(
			activity.read(
				new URLSearchParams({ cursor: before.cursor }),
				context.operation(),
			),
		).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
		const fresh = (await activity.watermark(context.operation())).data;
		await activity.publish();
		const replay = await activity.read(
			new URLSearchParams({ cursor: fresh.cursor }),
			context.operation(),
		);
		expect(replay.data.map((event) => event.resource.revision)).toEqual(["2"]);
		const next = await context.database.transaction((tx) =>
			context.events.emit(tx, "license.deleted", { licenseId, groupId: null }),
		);
		expect(next.resource.revision).toBe("3");
		const remaining = await context.database.orm
			.select()
			.from(activityEvents)
			.orderBy(asc(activityEvents.ordinal));
		expect(remaining.map((row) => row.id)).toEqual([pending.id, next.id]);
	} finally {
		await context.database.orm
			.delete(webhooks)
			.where(eq(webhooks.id, endpoint));
	}
});

test("byte-bounded replay pages never strand or skip an event", async () => {
	await activity.publish(1000);
	const bounded = new ActivityService(
		context.database,
		context.auth,
		context.redis,
		[],
		100,
		{ batchBytes: 34816 },
	);
	let cursor = (await bounded.watermark(context.operation())).data.cursor;
	const expected: string[] = [];
	await context.database.transaction(async (tx) => {
		for (let i = 0; i < 100; i++) {
			const event = await context.events.emit(tx, "license.created", {
				licenseId: Bun.randomUUIDv7(),
				groupId: null,
			});
			expected.push(event.id);
		}
	});
	await bounded.publish(1000);
	const ids: string[] = [];
	let pages = 0;
	for (;;) {
		const result = await bounded.read(
			new URLSearchParams({ cursor, limit: "100" }),
			context.operation(),
		);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
			34816,
		);
		ids.push(...result.data.map((event) => event.id));
		pages++;
		if (!result.hasMore) break;
		expect(result.data.length).toBeGreaterThan(0);
		expect(pages).toBeLessThan(5);
		cursor = result.cursor;
	}
	expect(pages).toBeGreaterThan(1);
	expect(ids).toEqual(expected);
});
