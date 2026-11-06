import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { t } from "elysia";
import { RestoreService } from "../../core/database/RestoreService";
import { activityEvents, eventState } from "../../core/database/schema/events";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { audits } from "../../core/database/schema/audits";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { ActivityService } from "../../plugins/activity/ActivityService";
import { WebhookService } from "../../plugins/webhooks/WebhookService";
import { TestContext } from "../fixtures/TestContext";
import { checkedJSON } from "../fixtures/Json";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());

test("offline restore preparation is atomic, changes the epoch and requires delivery review without deleting licences or usage", async () => {
	const activity = new ActivityService(
		context.database,
		context.auth,
		context.redis,
	);
	await activity.publish();
	const hooks = new WebhookService(
		context.database,
		context.auth,
		context.audit,
		context.settings,
		context.idempotency,
		{
			encryptionKey: Buffer.from(
				crypto.getRandomValues(new Uint8Array(32)),
			).toString("hex"),
		},
	);
	const hook = await hooks.create(
		{
			url: "https://receiver.example/events",
			events: ["license.created"],
			allGroups: true,
		},
		context.operation(),
	);
	await hooks.enable({ ids: [hook.data.id] }, context.operation());
	const license = await context.licenses.create(
		{ meters: { upsert: [{ name: "requests", limit: "10" }] } },
		context.operation(),
	);
	await context.licenses.enable(
		{ ids: [license.data.id] },
		context.operation(),
	);
	const consumed = await context.licenses.consume(
		{ licenseId: license.data.id, usage: { requests: "2" } },
		context.operation(),
	);
	await activity.publish();
	const watermark = await activity.watermark(context.operation());
	const [endpoint] = await context.database.orm
		.select()
		.from(webhooks)
		.where(eq(webhooks.id, hook.data.id));
	const [event] = await context.database.orm
		.select()
		.from(activityEvents)
		.where(
			and(
				eq(activityEvents.resourceId, license.data.id),
				eq(activityEvents.event, "license.created"),
			),
		);
	if (!endpoint || !event) throw new Error("Missing restore fixtures");
	const id = Bun.randomUUIDv7();
	const claimToken = Bun.randomUUIDv7();
	const now = new Date();
	await context.database.orm.insert(deliveries).values({
		id,
		webhookId: endpoint.id,
		eventId: event.id,
		groupId: event.groupId,
		global: event.global,
		endpointVersion: endpoint.version,
		url: endpoint.url,
		secretCiphertext: endpoint.secretCiphertext,
		signingKeyId: endpoint.signingKeyId,
		payload: event.payload,
		state: "claimed",
		attempts: 1,
		claimToken,
		leaseUntil: new Date(now.getTime() + 120000),
		expiresAt: new Date(now.getTime() + 86400000),
	});
	await context.database.orm.insert(deliveryAttempts).values({
		id: claimToken,
		deliveryId: id,
		attempt: 1,
		startedAt: now,
		sendStartedAt: now,
	});
	await context.database.orm.execute(sql`create function reject_restore_fixture() returns trigger language plpgsql as $$
		begin if new.action = 'system.restore_prepared' then raise exception 'restore fixture rollback'; end if; return new; end $$`);
	await context.database.orm.execute(
		sql`create trigger reject_restore_fixture before insert on audit_logs for each row execute function reject_restore_fixture()`,
	);
	try {
		await expect(
			new RestoreService(context.database).prepare(),
		).rejects.toThrow();
		expect(
			(await context.database.orm.select().from(eventState))[0]?.epoch,
		).toBe(watermark.data.epoch);
		expect(
			(
				await context.database.orm
					.select()
					.from(webhooks)
					.where(eq(webhooks.id, endpoint.id))
			)[0]?.enabled,
		).toBe(true);
		expect(
			(
				await context.database.orm
					.select()
					.from(deliveries)
					.where(eq(deliveries.id, id))
			)[0]?.state,
		).toBe("claimed");
		expect(
			(
				await context.database.orm
					.select()
					.from(deliveryAttempts)
					.where(eq(deliveryAttempts.id, claimToken))
			)[0]?.completedAt,
		).toBeNull();
	} finally {
		await context.database.orm.execute(
			sql`drop trigger reject_restore_fixture on audit_logs`,
		);
		await context.database.orm.execute(
			sql`drop function reject_restore_fixture()`,
		);
	}
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			fileURLToPath(new URL("../../main.ts", import.meta.url)),
			"prepare-restore",
			"--confirm-restored-database",
		],
		{
			env: {
				PATH: Bun.env.PATH,
				KZ_MIGRATION_DATABASE_URL: context.fixture.url,
			},
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(10000),
		},
	);
	const [output, diagnostics, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(diagnostics).toBe("");
	expect(exit).toBe(0);
	const prepared = await checkedJSON(
		new Response(output),
		t.Object({
			event: t.Literal("restore.prepared"),
			epoch: t.String(),
			disabledWebhooks: t.Integer(),
			cancelledDeliveries: t.Integer(),
			schemaFingerprint: t.String(),
		}),
	);
	expect(prepared).toMatchObject({
		disabledWebhooks: 1,
		cancelledDeliveries: 1,
	});
	expect(prepared.epoch).not.toBe(watermark.data.epoch);
	expect(
		(
			await context.database.orm
				.select()
				.from(webhooks)
				.where(eq(webhooks.id, endpoint.id))
		)[0]?.enabled,
	).toBe(false);
	expect(
		(
			await context.database.orm
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, id))
		)[0],
	).toMatchObject({ state: "cancelled", claimToken: null, leaseUntil: null });
	expect(
		(
			await context.database.orm
				.select()
				.from(deliveryAttempts)
				.where(eq(deliveryAttempts.id, claimToken))
		)[0]?.error,
	).toBe("restore_outcome_unknown");
	await expect(
		activity.read(
			new URLSearchParams({ cursor: watermark.data.cursor }),
			context.operation(),
		),
	).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
	expect(
		(
			await context.validation.validate(
				{ license: license.credential },
				context.operation(),
			)
		).data.valid,
	).toBe(true);
	expect(
		await context.database.orm
			.select()
			.from(usageOperations)
			.where(eq(usageOperations.id, consumed.data.id)),
	).toHaveLength(1);
	expect(
		await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.action, "system.restore_prepared")),
	).toHaveLength(1);
	activity.stop();
});
