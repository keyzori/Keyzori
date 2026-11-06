import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Database } from "../../core/database/Database";
import { meters } from "../../core/database/schema/meters";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { audits } from "../../core/database/schema/audits";
import { activityEvents } from "../../core/database/schema/events";
import { LicenseService } from "../../plugins/licenses/LicenseService";
import { EventService } from "../../plugins/webhooks/EventService";
import { TestContext } from "../fixtures/TestContext";
import { TcpProxy } from "../fixtures/TcpProxy";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("recognized transaction conflicts retry complete rolled-back work only", async () => {
	const operation = context.operation();
	let attempts = 0;
	await context.database.idempotentTransaction(async (tx) => {
		await context.audit.record(tx, {
			...operation,
			actor: operation.principal,
			targetType: "system",
			action: "test.retry",
		});
		if (++attempts === 1)
			await tx.execute(
				sql`do $$ begin raise exception 'retry fixture' using errcode = '40001'; end $$`,
			);
	});
	expect(attempts).toBe(2);
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.requestId, operation.requestId)),
	).toHaveLength(1);
});

test("consume recovers a lost COMMIT acknowledgement without another charge or event", async () => {
	const key = await context.licenses.create(
		{ meters: { upsert: [{ name: "requests", limit: "2" }] } },
		context.operation(),
	);
	await context.licenses.enable({ ids: [key.data.id] }, context.operation());
	const proxy = new TcpProxy(new URL(context.fixture.url));
	const database = new Database(await proxy.start(), 1);
	const events = new EventService();
	const emit = events.emitChecked.bind(events);
	events.emitChecked = async (...args) => {
		const result = await emit(...args);
		if (args[1] === "usage.consumed") proxy.dropResponses = true;
		return result;
	};
	const service = new LicenseService(
		database,
		context.auth,
		context.audit,
		events,
		context.settings,
		context.idempotency,
		context.meters,
		context.deletion,
		context.ip,
	);
	const operation = { ...context.operation(), deadlineAt: Date.now() + 1500 };
	const input = { licenseId: key.data.id, usage: { requests: "1" } };
	try {
		await expect(service.consume(input, operation)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		const recorded = await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.licenseId, key.data.id));
		expect(recorded).toHaveLength(1);
		proxy.dropResponses = false;
		const replay = await context.licenses.consume(input, {
			...operation,
			deadlineAt: Date.now() + 5000,
		});
		expect(replay.data).toMatchObject({ id: recorded[0]?.id, replayed: true });
		expect(
			(
				await context.database.orm
					.select()
					.from(meters)
					.where(eq(meters.licenseId, key.data.id))
			)[0]?.value,
		).toBe("1");
		expect(
			await context.database.orm
				.select()
				.from(usageOperations)
				.where(eq(usageOperations.licenseId, key.data.id)),
		).toHaveLength(1);
		expect(
			await context.database.orm
				.select()
				.from(audits)
				.where(
					and(
						eq(audits.targetId, key.data.id),
						eq(audits.action, "usage.consumed"),
					),
				),
		).toHaveLength(1);
		expect(
			await context.database.orm
				.select()
				.from(activityEvents)
				.where(
					and(
						eq(activityEvents.resourceId, key.data.id),
						eq(activityEvents.event, "usage.consumed"),
					),
				),
		).toHaveLength(1);
	} finally {
		proxy.dropResponses = false;
		await proxy.stop();
		await database.close();
	}
});
