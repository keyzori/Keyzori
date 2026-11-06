import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { audits } from "../../core/database/schema/audits";
import { activityEvents } from "../../core/database/schema/events";
import { licenses } from "../../core/database/schema/licenses";
import { meters } from "../../core/database/schema/meters";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { LicenseContext } from "../../plugins/licenses/LicenseContext";
import { TestContext } from "../fixtures/TestContext";

const context = new TestContext();
const activity = new ActivityService(
	context.database,
	context.auth,
	context.redis,
);
const licensing = new LicenseContext(context.auth);
beforeAll(() => context.start());
afterAll(async () => {
	activity.stop();
	await context.stop();
});

async function reader(groupIds: string[], allGroups = false) {
	const issued = await context.apiKeys.create(
		{ name: "Counter history reader" },
		context.operation(),
	);
	await context.apiKeys.update(
		{
			ids: [issued.data.id],
			changes: {
				scopes: ["events:read", "usage:read", "audits:read"],
				groupIds,
				allGroups,
			},
		},
		context.operation(),
	);
	await context.apiKeys.enable({ ids: [issued.data.id] }, context.operation());
	return {
		...context.operation(),
		principal: await context.auth.authenticate(`Bearer ${issued.credential}`),
	};
}

test("all counter event paths retain both groups' authority through a transfer", async () => {
	const a = await context.groups.create(
		{ name: "Source" },
		context.operation(),
	);
	const b = await context.groups.create(
		{ name: "Destination" },
		context.operation(),
	);
	const issued = await context.licenses.create(
		{
			groupId: a.data.id,
			meters: {
				upsert: [
					{ name: "removed", limit: "37" },
					{ name: "edited", limit: "10" },
					{ name: "scheduled", schedule: { interval: "day", time: "00:00" } },
					{ name: "manual", limit: "2" },
					{ name: "consumed", limit: "1" },
				],
			},
		},
		context.operation(),
	);
	await context.licenses.adjust(
		{ ids: [issued.data.id], name: "edited", action: "set", value: "3" },
		context.operation(),
	);
	// A missed reset must inherit the same transfer guards as definition edits.
	await context.database.orm
		.update(meters)
		.set({
			value: "7",
			periodStartedAt: new Date("2020-01-01T00:00:00Z"),
			nextResetAt: new Date("2020-01-02T00:00:00Z"),
		})
		.where(
			and(eq(meters.licenseId, issued.data.id), eq(meters.name, "scheduled")),
		);
	const readers = [
		await reader([a.data.id]),
		await reader([b.data.id]),
		await reader([a.data.id, b.data.id]),
		await reader([], true),
	];
	await activity.publish(1000);
	const cursors = await Promise.all(
		readers.map((operation) => activity.watermark(operation)),
	);
	const operation = context.operation();
	const guards = {
		groupId: b.data.id,
		requiredGroupIds: [a.data.id, b.data.id],
		requiresAllGroups: false,
	};
	await context.database.transaction(async (tx) => {
		await licensing.lock(tx, [issued.data.id]);
		const now = await licensing.now(tx);
		await tx
			.update(licenses)
			.set({ groupId: b.data.id })
			.where(eq(licenses.id, issued.data.id));
		const evidence = {
			...licensing.evidence(operation, issued.data.id),
			...guards,
		};
		await context.meters.definitions(
			tx,
			issued.data.id,
			{
				remove: ["removed"],
				upsert: [{ name: "edited", limit: "2" }, { name: "created" }],
			},
			evidence,
			now,
		);
		await context.meters.adjust(
			tx,
			issued.data.id,
			"manual",
			"set",
			"3",
			evidence,
			now,
		);
		await context.meters.adjust(
			tx,
			issued.data.id,
			"manual",
			"reset",
			undefined,
			evidence,
			now,
		);
		const counters = await context.meters.effective(
			tx,
			issued.data.id,
			evidence,
			now,
		);
		await context.meters.consume(
			tx,
			counters,
			{ consumed: "1" },
			evidence,
			now,
		);
	});
	const emitted = await context.database.orm
		.select()
		.from(activityEvents)
		.where(
			and(
				eq(activityEvents.resourceId, issued.data.id),
				eq(activityEvents.groupId, b.data.id),
			),
		);
	expect(emitted).toHaveLength(9);
	expect(new Set(emitted.map((event) => event.event))).toEqual(
		new Set([
			"meter.created",
			"meter.updated",
			"meter.deleted",
			"meter.reset",
			"meter.adjusted",
			"meter.limit_reached",
		]),
	);
	for (const event of emitted) {
		expect(event).toMatchObject(guards);
		expect(event.payload.data).toMatchObject({ groupId: b.data.id });
		expect(JSON.stringify(event.payload)).not.toContain(a.data.id);
		expect(JSON.stringify(event.payload)).not.toContain("requiredGroupIds");
		expect(JSON.stringify(event.payload)).not.toContain("requiresAllGroups");
	}
	const evidence = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.requestId, operation.requestId));
	expect(evidence).toHaveLength(6);
	for (const row of evidence) expect(row).toMatchObject(guards);
	await activity.publish(1000);
	for (const [index, principal] of readers.entries()) {
		const cursor = cursors[index]?.data.cursor;
		if (!cursor) throw new Error("Missing reader cursor");
		const visible = index >= 2;
		const page = await activity.read(
			new URLSearchParams({ cursor }),
			principal,
		);
		expect(page.data).toHaveLength(visible ? emitted.length : 0);
		for (const row of evidence) {
			const history = await activity.history(
				new URLSearchParams({ id: row.id }),
				principal,
			);
			expect(history.data).toHaveLength(visible ? 1 : 0);
		}
	}
});

test("counter history involving ungrouped authority requires all-groups access and preserves explicit null routing", async () => {
	const group = await context.groups.create(
		{ name: "Named destination" },
		context.operation(),
	);
	const issued = await context.licenses.create(
		{ groupId: group.data.id },
		context.operation(),
	);
	const selected = await reader([group.data.id]);
	const all = await reader([], true);
	await activity.publish(1000);
	const selectedCursor = (await activity.watermark(selected)).data.cursor;
	const allCursor = (await activity.watermark(all)).data.cursor;
	const operation = context.operation();
	await context.database.transaction(async (tx) => {
		await licensing.lock(tx, [issued.data.id]);
		const now = await licensing.now(tx);
		for (const [name, groupId] of [
			["destination", group.data.id],
			["ungrouped", null],
		] as const) {
			await context.meters.definitions(
				tx,
				issued.data.id,
				{ upsert: [{ name }] },
				{
					...licensing.evidence(operation, issued.data.id),
					groupId,
					requiredGroupIds: [group.data.id],
					requiresAllGroups: true,
				},
				now,
			);
		}
	});
	const emitted = await context.database.orm
		.select()
		.from(activityEvents)
		.where(
			and(
				eq(activityEvents.resourceId, issued.data.id),
				eq(activityEvents.event, "meter.created"),
			),
		);
	expect(emitted).toHaveLength(2);
	for (const event of emitted)
		expect(event).toMatchObject({
			requiredGroupIds: [group.data.id],
			requiresAllGroups: true,
		});
	const ungrouped = emitted.find(
		(row) =>
			"meter" in row.payload.data && row.payload.data.meter === "ungrouped",
	);
	expect(ungrouped).toMatchObject({
		groupId: null,
		payload: { data: { groupId: null } },
	});
	await activity.publish(1000);
	expect(
		(
			await activity.read(
				new URLSearchParams({ cursor: selectedCursor }),
				selected,
			)
		).data,
	).toEqual([]);
	expect(
		(await activity.read(new URLSearchParams({ cursor: allCursor }), all)).data,
	).toHaveLength(2);
	const evidence = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.requestId, operation.requestId));
	expect(evidence).toHaveLength(2);
	for (const row of evidence) {
		expect(
			(await activity.history(new URLSearchParams({ id: row.id }), selected))
				.data,
		).toEqual([]);
		expect(
			(await activity.history(new URLSearchParams({ id: row.id }), all)).data,
		).toHaveLength(1);
	}
});
