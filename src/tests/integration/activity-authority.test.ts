import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { activityEvents } from "../../core/database/schema/events";
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

async function reader(groupIds: string[], allGroups = false) {
	const key = await context.apiKeys.create(
		{ name: "Historical event reader" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [key.data.id],
			changes: {
				scopes: ["events:read", "licenses:read", "usage:read", "audits:read"],
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

test("internal historical guards are conjunctive and UUID case cannot split visibility or revisions", async () => {
	const a = await context.groups.create(
		{ name: "Guard A" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Guard B" },
		context.operation(),
	);
	const source = await reader([a.data.id]);
	const destination = await reader([b.data.id]);
	const both = await reader([a.data.id, b.data.id]);
	const all = await reader([], true);
	await activity.publish(1000);
	const cursors = await Promise.all(
		[source, destination, both, all].map(
			async (operation) => (await activity.watermark(operation)).data.cursor,
		),
	);
	const licenseId = Bun.randomUUIDv7();
	const counterId = Bun.randomUUIDv7();
	const event = await context.database.transaction((tx) =>
		context.events.emit(
			tx,
			"meter.deleted",
			{
				licenseId: licenseId.toUpperCase(),
				groupId: b.data.id.toUpperCase(),
				counterId,
				meter: "source-private-counter",
				definitionRevision: 1,
				resetGeneration: 0,
				periodId: `${counterId}:1:0:lifetime`,
				periodStartedAt: null,
				periodEndsAt: null,
				value: "4",
				limit: null,
			},
			new Date(),
			{ requiredGroupIds: [a.data.id.toUpperCase(), b.data.id, a.data.id] },
		),
	);
	await activity.publish(1000);
	for (const [index, operation] of [source, destination, both, all].entries()) {
		const cursor = cursors[index];
		if (!cursor) throw new Error("Expected authority-bound cursor");
		const result = await activity.read(
			new URLSearchParams({ cursor }),
			operation,
		);
		if (index < 2) expect(result.data).toEqual([]);
		else expect(result.data.map((item) => item.id)).toEqual([event.id]);
	}
	const [stored] = await context.database.orm
		.select()
		.from(activityEvents)
		.where(eq(activityEvents.id, event.id));
	expect(stored?.requiredGroupIds).toEqual([a.data.id, b.data.id].sort());
	expect(stored?.requiresAllGroups).toBe(false);
	expect(stored?.groupId).toBe(b.data.id);
	expect(event.resource.id).toBe(licenseId);
	expect(JSON.stringify(event)).not.toContain(a.data.id);
	expect(JSON.stringify(event)).not.toContain("requiredGroupIds");
	const next = await context.database.transaction((tx) =>
		context.events.emit(tx, "license.updated", {
			licenseId,
			groupId: b.data.id,
		}),
	);
	expect(next.resource.revision).toBe("2");
	const origin = (await activity.watermark(all)).data.cursor;
	await context.database.transaction((tx) =>
		context.events.emit(
			tx,
			"license.updated",
			{ licenseId, groupId: b.data.id },
			new Date(),
			{ requiredGroupIds: [b.data.id], requiresAllGroups: true },
		),
	);
	await activity.publish(1000);
	const allResult = await activity.read(
		new URLSearchParams({ cursor: origin }),
		all,
	);
	expect(allResult.data).toHaveLength(2);
	const bothCursor = cursors[2];
	if (!bothCursor) throw new Error("Expected both-groups cursor");
	const restricted = await activity.read(
		new URLSearchParams({ cursor: bothCursor }),
		both,
	);
	expect(restricted.data.map((item) => item.resource.revision)).toEqual([
		"1",
		"2",
	]);
});

test("an atomic transfer and counter replacement hides both removed and created counter history from either group alone", async () => {
	const a = await context.groups.create(
		{ name: "Counter origin" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Counter destination" },
		context.operation(),
	);
	const issued = await context.licenses.create(
		{
			groupId: a.data.id,
			meters: { upsert: [{ name: "removed-source-name", limit: "10" }] },
		},
		context.operation(),
	);
	const source = await reader([a.data.id]);
	const destination = await reader([b.data.id]);
	const both = await reader([a.data.id, b.data.id]);
	await activity.publish(1000);
	const cursors = await Promise.all(
		[source, destination, both].map(
			async (operation) => (await activity.watermark(operation)).data.cursor,
		),
	);
	await context.licenses.update(
		{
			ids: [issued.data.id],
			changes: {
				groupId: b.data.id,
				meters: {
					remove: ["removed-source-name"],
					upsert: [{ name: "created-destination-name", limit: "5" }],
				},
			},
		},
		context.operation(),
	);
	await activity.publish(1000);
	for (const [index, operation] of [source, destination, both].entries()) {
		const cursor = cursors[index];
		if (!cursor) throw new Error("Expected cursor");
		const result = await activity.read(
			new URLSearchParams({ cursor }),
			operation,
		);
		const counters = result.data.filter((event) =>
			event.event.startsWith("meter."),
		);
		if (index < 2) {
			expect(counters).toEqual([]);
			expect(JSON.stringify(result.data)).not.toContain("removed-source-name");
			expect(JSON.stringify(result.data)).not.toContain(
				"created-destination-name",
			);
		} else
			expect(counters.map((event) => event.event)).toEqual([
				"meter.deleted",
				"meter.created",
			]);
	}
	const records = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.targetId, issued.data.id));
	const replacements = records.filter(
		(record) =>
			record.action === "meter.deleted" ||
			(record.action === "meter.created" &&
				JSON.stringify(record.after).includes("created-destination-name")),
	);
	expect(replacements).toHaveLength(2);
	for (const record of replacements) {
		expect(record.requiredGroupIds.slice().sort()).toEqual(
			[a.data.id, b.data.id].sort(),
		);
		for (const operation of [source, destination])
			expect(
				(
					await activity.history(
						new URLSearchParams({ id: record.id }),
						operation,
					)
				).data,
			).toEqual([]);
		expect(
			(await activity.history(new URLSearchParams({ id: record.id }), both))
				.data,
		).toHaveLength(1);
	}
	const current = await context.licenses.read(
		new URLSearchParams({ id: issued.data.id }),
		destination,
	);
	if (Array.isArray(current.data)) throw new Error("Expected current detail");
	expect(current.data.meters.map((meter) => meter.name)).toEqual([
		"created-destination-name",
	]);
});
