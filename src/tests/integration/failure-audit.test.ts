import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TestContext } from "../fixtures/TestContext";
import { activityEvents } from "../../core/database/schema/events";
import { audits } from "../../core/database/schema/audits";
import { FailureAuditService } from "../../plugins/audits/FailureAuditService";
import { settingsDefaults } from "../../plugins/settings/defaults";

const context = new TestContext();
beforeAll(() => context.start());
afterAll(() => context.stop());
const source = () =>
	`2001:db8:${Bun.randomUUIDv7().slice(-12).match(/.{4}/g)?.join(":")}::1`;

test("unknown failures aggregate by trusted source and never persist submitted identity or credential text", async () => {
	const request = { ...context.operation(), clientIp: source() };
	await context.settings.update(
		{ failureThreshold: 2 },
		request.principal,
		request,
	);
	const sentinel = `unverified-${Bun.randomUUIDv7()}`;
	for (const number of [1, 2, 3]) {
		const reply = await context.validation.validate(
			{
				license: `${sentinel}-license-${number}`,
				hardwareId: `${sentinel}-device-${number}`,
			},
			request,
		);
		expect(reply.data.code).toBe("LICENSE_INVALID");
	}
	const evidence = await context.database.orm
		.select()
		.from(audits)
		.where(eq(audits.action, "validation.failed"));
	expect(evidence).toHaveLength(1);
	expect(evidence[0]).toMatchObject({
		actor: { kind: "anonymous" },
		hardwareId: null,
		targetId: null,
		after: { code: "LICENSE_INVALID" },
	});
	const events = await context.database.orm
		.select()
		.from(activityEvents)
		.where(eq(activityEvents.event, "validation.failed"));
	expect(events).toHaveLength(1);
	expect(
		JSON.stringify([evidence, events], (_, v: unknown) =>
			typeof v === "bigint" ? String(v) : v,
		),
	).not.toContain(sentinel);
});

test.each(["before commit", "after commit"])(
	"failed threshold %s recovers one audit/event pair without a fresh threshold",
	async (phase) => {
		const licenseId = Bun.randomUUIDv7();
		const request = { ...context.operation(), clientIp: source() };
		let fault = true;
		const failures = new FailureAuditService(
			{
				transaction: async (work, topology, deadline) => {
					if (fault && phase === "before commit") {
						fault = false;
						throw new Error("Fixture rejection");
					}
					const result = await context.database.transaction(
						work,
						topology,
						deadline,
					);
					if (fault) {
						fault = false;
						throw new Error("Fixture lost acknowledgment");
					}
					return result;
				},
			},
			context.redis,
			context.audit,
			context.events,
			{ read: async () => ({ ...settingsDefaults, failureThreshold: 2 }) },
		);
		const record = () =>
			failures.record("LICENSE_DISABLED", licenseId, request);
		await record();
		await expect(record()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		await Promise.all([record(), record(), record()]);
		const evidence = await context.database.orm
			.select()
			.from(audits)
			.where(eq(audits.targetId, licenseId));
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.hardwareId).toBeNull();
		expect(
			await context.database.orm
				.select({ id: activityEvents.id })
				.from(activityEvents)
				.where(eq(activityEvents.resourceId, licenseId)),
		).toHaveLength(1);
	},
);
