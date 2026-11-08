import { eq, inArray, isNull, sql } from "drizzle-orm";
import { deliveries, deliveryAttempts } from "./schema/deliveries";
import { webhooks } from "./schema/webhooks";
import { AuditService } from "../../plugins/audits/AuditService";
import { resetEventEpoch } from "../../plugins/activity/EventEpoch";
import { MigrationService } from "./MigrationService";
import type { Database } from "./Database";

/** Explicit offline preparation of a restored database, never a server-startup repair. */
export class RestoreService {
	constructor(private readonly database: Database) {}
	async prepare() {
		const history = await new MigrationService(this.database).verify();
		return this.database.transaction(async (tx) => {
			const [clock] = await tx
				.select({ now: sql<Date>`clock_timestamp()` })
				.from(sql`(values(1)) as clock`);
			if (!clock) throw new Error("Database clock unavailable");
			const disabled = await tx
				.update(webhooks)
				.set({
					enabled: false,
					version: sql`${webhooks.version} + 1`,
					lastError: "restore_requires_review",
					updatedAt: clock.now,
					updatedBy: "restore",
				})
				.where(eq(webhooks.enabled, true))
				.returning({ id: webhooks.id });
			await tx
				.update(deliveryAttempts)
				.set({ completedAt: clock.now, error: "restore_outcome_unknown" })
				.where(isNull(deliveryAttempts.completedAt));
			const cancelled = await tx
				.update(deliveries)
				.set({
					state: "cancelled",
					claimToken: null,
					leaseUntil: null,
					error: "restore_requires_review",
				})
				.where(inArray(deliveries.state, ["pending", "claimed"]))
				.returning({ id: deliveries.id });
			const epoch = await resetEventEpoch(tx);
			await new AuditService().record(tx, {
				actor: { kind: "system", id: "restore", name: "Restore preparation" },
				action: "system.restore_prepared",
				targetType: "system",
				requestId: Bun.randomUUIDv7(),
				clientIp: "",
				after: {
					...epoch,
					schemaFingerprint: history.fingerprint,
					disabledWebhooks: disabled.length,
					cancelledDeliveries: cancelled.length,
				},
			});
			return {
				...epoch,
				schemaFingerprint: history.fingerprint,
				disabledWebhooks: disabled.length,
				cancelledDeliveries: cancelled.length,
			};
		}, "write");
	}
}
