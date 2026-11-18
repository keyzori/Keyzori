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
	async prepare(deadlineAt?: number) {
		return this.database.schemaTransaction(
			"restore",
			async (tx) => {
				const history = await new MigrationService(this.database).verifyRestore(
					tx,
				);
				const [clock] = await tx
					.select({ now: sql<Date>`clock_timestamp()` })
					.from(sql`(values(1)) as clock`);
				if (!clock) throw new Error("Database clock unavailable");
				const disable = tx
					.update(webhooks)
					.set({
						enabled: false,
						version: sql`${webhooks.version} + 1`,
						lastError: "restore_requires_review",
						updatedAt: clock.now,
						updatedBy: "restore",
					})
					.where(eq(webhooks.enabled, true))
					.returning({ changed: sql`1` });
				const [disabled] = await tx.execute<{ count: number }>(
					sql`with changed as (${disable.getSQL()}) select count(*)::integer as count from changed`,
				);
				const cancel = tx
					.update(deliveries)
					.set({
						state: "cancelled",
						terminalAt: clock.now,
						secretCiphertext: null,
						claimToken: null,
						leaseUntil: null,
						error: "restore_requires_review",
					})
					.where(inArray(deliveries.state, ["pending", "claimed"]))
					.returning({ changed: sql`1` });
				const [cancelled] = await tx.execute<{ count: number }>(
					sql`with changed as (${cancel.getSQL()}) select count(*)::integer as count from changed`,
				);
				await tx
					.update(deliveryAttempts)
					.set({ completedAt: clock.now, error: "restore_outcome_unknown" })
					.where(isNull(deliveryAttempts.completedAt));
				if (!disabled || !cancelled)
					throw new Error("Restore counts unavailable");
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
						disabledWebhooks: disabled.count,
						cancelledDeliveries: cancelled.count,
					},
				});
				return {
					...epoch,
					schemaFingerprint: history.fingerprint,
					disabledWebhooks: disabled.count,
					cancelledDeliveries: cancelled.count,
				};
			},
			deadlineAt,
		);
	}
}
