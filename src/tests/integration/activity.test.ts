import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { activityEvents } from "../../core/database/schema/events";
import type { $Operation } from "../../types/operation";
import type { $EventEnvelope } from "../../types/webhooks";

function licenseIdOf(event: $EventEnvelope) {
	return "licenseId" in event.data ? event.data.licenseId : undefined;
}

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

async function currentCursor(operation = context.operation()) {
	for (let i = 0; i < 10; i++) if ((await activity.publish()) < 100) break;
	let result = await activity.read(
		new URLSearchParams({ limit: "100" }),
		operation,
	);
	for (let i = 0; result.hasMore && i < 10; i++)
		result = await activity.read(
			new URLSearchParams({ cursor: result.cursor, limit: "100" }),
			operation,
		);
	return result.cursor;
}

async function scoped(groupId: string) {
	const key = await context.apiKeys.create(
		{ name: "Activity integration" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [key.data.id],
			changes: {
				scopes: [
					"events:read",
					"events:subscribe",
					"audits:read",
					"licenses:read",
					"groups:read",
				],
				groupIds: [groupId],
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [key.data.id] }, context.operation());
	const operation = {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${key.credential}`),
	};
	return { key, operation };
}

function socket() {
	const frames: unknown[] = [];
	const closed: { code?: number; reason?: string }[] = [];
	return {
		frames,
		closed,
		transport: {
			id: Bun.randomUUIDv7(),
			send(value: unknown) {
				const parsed: unknown =
					typeof value === "string" ? JSON.parse(value) : value;
				frames.push(parsed);
				return 1;
			},
			close(code?: number, reason?: string) {
				closed.push({ code, reason });
			},
		},
	};
}

async function waitUntil(predicate: () => boolean, timeout = 2500) {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
	expect(predicate()).toBe(true);
}

function frameContains(frames: unknown[], id: string) {
	return frames.some(
		(frame) =>
			frame &&
			typeof frame === "object" &&
			"data" in frame &&
			Array.isArray(frame.data) &&
			frame.data.some(
				(event: unknown) =>
					event &&
					typeof event === "object" &&
					"id" in event &&
					event.id === id,
			),
	);
}

test("events persist without subscribers and roll back with their producing transaction", async () => {
	const cursor = await currentCursor();
	const committed = Bun.randomUUIDv7();
	await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", {
			licenseId: committed,
			groupId: null,
		}),
	);
	const rolledBack = Bun.randomUUIDv7();
	await expect(
		context.database.transaction(async (tx) => {
			await context.events.emit(tx, "license.created", {
				licenseId: rolledBack,
				groupId: null,
			});
			throw new Error("rollback probe");
		}),
	).rejects.toThrow("rollback probe");
	await activity.publish();
	const result = await activity.read(
		new URLSearchParams({ cursor }),
		context.operation(),
	);
	expect(result.data.some((event) => licenseIdOf(event) === committed)).toBe(
		true,
	);
	expect(result.data.some((event) => licenseIdOf(event) === rolledBack)).toBe(
		false,
	);
});

test("publication cursor cannot skip a producer that commits out of allocation order", async () => {
	const cursor = await currentCursor();
	const slowId = Bun.randomUUIDv7();
	const fastId = Bun.randomUUIDv7();
	const inserted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const slow = context.database.transaction(async (tx) => {
		await context.events.emit(tx, "license.created", {
			licenseId: slowId,
			groupId: null,
		});
		inserted.resolve();
		await release.promise;
	});
	try {
		await inserted.promise;
		await context.database.transaction((tx) =>
			context.events.emit(tx, "license.created", {
				licenseId: fastId,
				groupId: null,
			}),
		);
		await activity.publish();
		const first = await activity.read(
			new URLSearchParams({ cursor }),
			context.operation(),
		);
		expect(first.data.map(licenseIdOf)).toEqual([fastId]);
		release.resolve();
		await slow;
		await activity.publish();
		const second = await activity.read(
			new URLSearchParams({ cursor: first.cursor }),
			context.operation(),
		);
		expect(second.data.map(licenseIdOf)).toEqual([slowId]);
		expect(BigInt(second.data[0]?.sequence ?? "0")).toBeGreaterThan(
			BigInt(first.data[0]?.sequence ?? "0"),
		);
	} finally {
		release.resolve();
		await slow;
	}
});

test("deleted-group snapshots do not leak into another group's stream or audit history", async () => {
	const a = await context.groups.create(
		{ name: "Historical A" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Unrelated B" },
		context.operation(),
	);
	const { operation } = await scoped(b.data.id);
	const rootCursor = await currentCursor();
	const bCursor = await currentCursor(operation);
	const issued = await context.licenses.create(
		{ groupId: a.data.id },
		context.operation(),
	);
	await context.groups.remove(
		{ ids: [a.data.id], confirm: true, reason: "Archive A" },
		context.operation(),
	);
	await activity.publish();
	const own = await activity.read(
		new URLSearchParams({ cursor: bCursor }),
		operation,
	);
	expect(own.data).toEqual([]);
	const root = await activity.read(
		new URLSearchParams({ cursor: rootCursor }),
		context.operation(),
	);
	expect(root.data).toContainEqual(
		expect.objectContaining({
			event: "license.disabled",
			data: { licenseId: issued.data.id, groupId: a.data.id },
		}),
	);
	const history = await activity.history(new URLSearchParams(), operation);
	expect(
		history.data.some((record) => record.targetId === issued.data.id),
	).toBe(false);
});

test("integration payloads exclude raw device and address fields", async () => {
	const licenseId = Bun.randomUUIDv7();
	await context.database.transaction((tx) =>
		context.events.emit(tx, "validation.failed", {
			licenseId,
			groupId: null,
			code: "DEVICE_NOT_REGISTERED",
			hardwareId: "private-device-id",
			clientIp: "192.0.2.55",
		}),
	);
	const stored = await context.database.orm
		.select()
		.from(activityEvents)
		.where(eq(activityEvents.event, "validation.failed"));
	const event = stored.find((row) => licenseIdOf(row.payload) === licenseId);
	expect(event).toBeDefined();
	expect(JSON.stringify(event?.payload)).not.toContain("private-device-id");
	expect(JSON.stringify(event?.payload)).not.toContain("192.0.2.55");
});

test("revocation closes a stream and rejects saved replay authority", async () => {
	const group = await context.groups.create(
		{ name: "Revocation" },
		context.operation(),
	);
	const { key, operation } = await scoped(group.data.id);
	const cursor = await currentCursor(operation);
	const client = socket();
	try {
		await activity.open(client.transport, operation);
		await activity.subscribe(client.transport.id, cursor);
		await context.apiKeys.disable({ ids: [key.data.id] }, context.operation());
		await expect(
			activity.read(new URLSearchParams({ cursor }), operation),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await waitUntil(() => client.closed.length > 0);
	} finally {
		activity.close(client.transport.id);
	}
});

test("replay and live polling share a durable cursor without a handoff gap", async () => {
	const operation: $Operation = context.operation();
	const cursor = await currentCursor(operation);
	const before = Bun.randomUUIDv7();
	await context.database.transaction((tx) =>
		context.events.emit(tx, "license.created", {
			licenseId: before,
			groupId: null,
		}),
	);
	await activity.publish();
	const client = socket();
	try {
		await activity.open(client.transport, operation);
		await activity.subscribe(client.transport.id, cursor);
		const [first] = await context.database.orm
			.select()
			.from(activityEvents)
			.where(eq(activityEvents.event, "license.created"))
			.orderBy(activityEvents.ordinal);
		expect(first).toBeDefined();
		const after = Bun.randomUUIDv7();
		await context.database.transaction((tx) =>
			context.events.emit(tx, "license.created", {
				licenseId: after,
				groupId: null,
			}),
		);
		await activity.publish();
		const rows = await context.database.orm
			.select()
			.from(activityEvents)
			.where(eq(activityEvents.event, "license.created"));
		const replayed = rows.find((row) => licenseIdOf(row.payload) === before);
		const live = rows.find((row) => licenseIdOf(row.payload) === after);
		if (!replayed || !live) throw new Error("Expected persisted events");
		await waitUntil(
			() =>
				frameContains(client.frames, replayed.id) &&
				frameContains(client.frames, live.id),
		);
	} finally {
		activity.close(client.transport.id);
	}
});

test("backlog reports measured transport bytes only when every active socket supports sampling", async () => {
	const measured = socket();
	const unknown = socket();
	try {
		await activity.open(
			{ ...measured.transport, raw: { getBufferedAmount: () => 137 } },
			context.operation(),
		);
		const first = await activity.backlog();
		expect(first.activeStreams).toBe(1);
		expect(first.queueMessages).toBe(0);
		expect(first.queueBytes).toBe(0);
		expect(first.transportBufferedBytes).toBe(137);
		await activity.open(unknown.transport, context.operation());
		const partial = await activity.backlog();
		expect(partial.activeStreams).toBe(2);
		expect("transportBufferedBytes" in partial).toBe(false);
	} finally {
		activity.close(measured.transport.id);
		activity.close(unknown.transport.id);
	}
	expect((await activity.backlog()).transportBufferedBytes).toBe(0);
});
