import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { licenses } from "./database/schema/licenses";
import { meters } from "./database/schema/meters";
import { receipts } from "./database/schema/receipts";
import { deliveries, deliveryAttempts } from "./database/schema/deliveries";
import { maintenanceRetries } from "./database/schema/maintenance";
import type { Database } from "./database/Database";
import type { MeterService } from "../plugins/licenses/MeterService";
import type { SettingsService } from "../plugins/settings/SettingsService";
import { Logger } from "./observability/Logger";
import type { Metrics, RetainedTable } from "./observability/Metrics";

export type MaintenanceBudgets = {
	resetRows: number;
	resetTimeMs: number;
	cleanupRows: number;
	cleanupTimeMs: number;
	observationTimeMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
};

export const maintenanceDefaults: Readonly<MaintenanceBudgets> = Object.freeze({
	resetRows: 100,
	resetTimeMs: 5000,
	cleanupRows: 1000,
	cleanupTimeMs: 5000,
	observationTimeMs: 1000,
	retryBaseMs: 60000,
	retryMaxMs: 3600000,
});

/** No runtime policy can expire immutable evidence or accepted-operation identity. */
export const maintenanceRetention = Object.freeze({
	events: "indefinite",
	audits: "immutable-indefinite",
	acceptedUsage: "immutable-indefinite-including-deduplication",
	administrativeReceipts: "expires-at",
	webhookAttempts: "terminal-delivery-only-webhookHistoryDays",
} as const);

/** Per-licence transactions and durable reservations isolate poison work across passes. */
export class MaintenanceService {
	readonly budgets: Readonly<MaintenanceBudgets>;
	constructor(
		private readonly database: Database,
		private readonly metering: MeterService,
		private readonly settings: SettingsService,
		private readonly logger?: Logger,
		budgets: Partial<MaintenanceBudgets> = {},
		private readonly metrics?: Metrics,
	) {
		const options = { ...maintenanceDefaults, ...budgets };
		for (const [name, value] of Object.entries(options)) {
			const maximum = name.endsWith("Rows")
				? 10000
				: name.startsWith("retry")
					? 86400000
					: 60000;
			if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
				throw new Error(`Invalid maintenance budget: ${name}`);
		}
		if (options.retryMaxMs < options.retryBaseMs)
			throw new Error("Invalid maintenance retry bounds");
		this.budgets = Object.freeze(options);
	}

	async runOnce() {
		const deadline = Date.now() + this.budgets.resetTimeMs;
		for (
			let pass = 0;
			pass < this.budgets.resetRows && Date.now() < deadline;
			pass++
		) {
			let current: string | undefined;
			try {
				// Persist backoff BEFORE executing the reset. A timeout or process crash must
				// not restore the same poison prefix to the front of the next worker's queue.
				const claim = await this.claim(deadline);
				if (!claim) break;
				current = claim.licenseId;
				const reset = await this.database.transaction(
					async (tx) => {
						const [row] = await tx
							.select({ id: licenses.id })
							.from(licenses)
							.where(eq(licenses.id, claim.licenseId))
							.for("update", { skipLocked: true });
						if (!row) return false;
						const [reservation] = await tx
							.select()
							.from(maintenanceRetries)
							.where(
								and(
									eq(maintenanceRetries.licenseId, row.id),
									eq(maintenanceRetries.claimToken, claim.claimToken),
								),
							);
						if (!reservation) return false;
						const [clock] = await tx
							.select({ now: sql<Date>`clock_timestamp()` })
							.from(sql`(values (1)) as clock`);
						if (!clock) throw new Error("Database clock unavailable");
						await this.metering.effective(
							tx,
							row.id,
							{
								actor: {
									kind: "system",
									id: "maintenance",
									name: "Maintenance",
								},
								action: "meter.reset",
								targetType: "license",
								targetId: row.id,
								requestId: Bun.randomUUIDv7(),
								clientIp: "",
							},
							clock.now,
						);
						await tx
							.delete(maintenanceRetries)
							.where(eq(maintenanceRetries.licenseId, row.id));
						return true;
					},
					"read",
					deadline,
				);
				this.metrics?.maintenance("resets", reset ? "succeeded" : "deferred");
			} catch (error) {
				this.metrics?.maintenance("resets", "failed");
				this.logger?.write("warn", "maintenance.reset.failed", {
					resourceId: current,
					phase: "maintenance_reset",
					code: "RESET_RETRY_SCHEDULED",
					cause: Logger.cause(error),
				});
				if (!current) break;
			}
		}
		await this.cleanup();
		if (this.metrics) await this.observe();
		return true;
	}

	private claim(deadline: number) {
		return this.database.transaction(
			async (tx) => {
				const [row] = await tx
					.select({ id: licenses.id })
					.from(meters)
					.innerJoin(licenses, eq(licenses.id, meters.licenseId))
					.where(
						and(
							lte(meters.nextResetAt, sql`clock_timestamp()`),
							sql`not exists (select 1 from ${maintenanceRetries} where ${maintenanceRetries.licenseId} = ${licenses.id} and ${maintenanceRetries.nextAttemptAt} > clock_timestamp())`,
						),
					)
					.orderBy(asc(meters.nextResetAt), asc(meters.licenseId))
					.limit(1)
					.for("update", { of: licenses, skipLocked: true });
				if (!row) return;
				const [claim] = await tx
					.insert(maintenanceRetries)
					.values({
						licenseId: row.id,
						claimToken: Bun.randomUUIDv7(),
						attempts: 1,
						attemptedAt: sql`statement_timestamp()`,
						nextAttemptAt: sql`statement_timestamp() + ${this.budgets.retryBaseMs} * interval '1 millisecond'`,
					})
					.onConflictDoUpdate({
						target: maintenanceRetries.licenseId,
						set: {
							claimToken: sql`excluded.claim_token`,
							attempts: sql`least(${maintenanceRetries.attempts} + 1, 32)`,
							attemptedAt: sql`statement_timestamp()`,
							nextAttemptAt: sql`statement_timestamp() + least(${this.budgets.retryMaxMs}, ${this.budgets.retryBaseMs} * power(2::numeric, least(${maintenanceRetries.attempts}, 20))) * interval '1 millisecond'`,
						},
						setWhere: lte(
							maintenanceRetries.nextAttemptAt,
							sql`clock_timestamp()`,
						),
					})
					.returning();
				return claim;
			},
			"none",
			deadline,
		);
	}

	private async cleanup() {
		const deadline = Date.now() + this.budgets.cleanupTimeMs;
		// Budgets are per retention family; batches release locks between transactions.
		for (const kind of ["receipts", "webhooks"] as const) {
			let remaining = this.budgets.cleanupRows;
			while (remaining > 0 && Date.now() < deadline) {
				const limit = Math.min(100, remaining);
				const deleted = await this.database.transaction(
					async (tx) => {
						if (kind === "receipts") {
							const rows =
								await tx.execute(sql`delete from ${receipts} where ctid in (
							select ctid from ${receipts} where ${receipts.expiresAt} <= clock_timestamp()
							order by ${receipts.expiresAt} limit ${limit} for update skip locked
						) returning 1`);
							return rows.length;
						}
						const settings = await this.settings.read(tx);
						if (settings.webhookHistoryDays === null) return 0;
						const parents = await tx
							.select({ id: deliveries.id })
							.from(deliveries)
							.where(
								and(
									sql`${deliveries.createdAt} < clock_timestamp() - ${settings.webhookHistoryDays} * interval '1 day'`,
									inArray(deliveries.state, [
										"succeeded",
										"failed",
										"cancelled",
									]),
									sql`not exists (select 1 from ${deliveryAttempts} where ${deliveryAttempts.deliveryId} = ${deliveries.id} and ${deliveryAttempts.completedAt} is null)`,
								),
							)
							.orderBy(asc(deliveries.createdAt), asc(deliveries.id))
							.limit(limit)
							.for("update", { skipLocked: true });
						if (!parents.length) return 0;
						const ids = parents.map((row) => row.id);
						// Count children against the same row budget rather than invoking an
						// unbounded FK cascade. Parent locks exclude recovery and new attempts.
						const attempts =
							await tx.execute(sql`delete from ${deliveryAttempts} where ctid in (
							select ctid from ${deliveryAttempts} where ${inArray(deliveryAttempts.deliveryId, ids)}
							order by ${deliveryAttempts.startedAt}, ${deliveryAttempts.id} limit ${limit} for update skip locked
						) returning 1`);
						const room = limit - attempts.length;
						if (!room) return attempts.length;
						const rows =
							await tx.execute(sql`delete from ${deliveries} where id in (
							select id from ${deliveries} where ${inArray(deliveries.id, ids)}
							and not exists (select 1 from ${deliveryAttempts} where ${deliveryAttempts.deliveryId} = ${deliveries.id})
							order by ${deliveries.createdAt}, ${deliveries.id} limit ${room}
						) returning 1`);
						return attempts.length + rows.length;
					},
					"none",
					deadline,
				);
				this.metrics?.maintenance(kind, "succeeded", deleted);
				remaining -= deleted;
				if (deleted < limit) break;
			}
		}
	}

	private async observe() {
		const metrics = this.metrics;
		if (!metrics) return;
		const limit = 10000;
		try {
			const sample = await this.database.transaction(
				async (tx) => {
					const settings = await this.settings.read(tx);
					const backlogs = await tx.execute<{
						kind: "resets" | "receipts" | "webhooks";
						count: number;
						age: number;
					}>(sql`
					select 'resets' as kind, count(*)::integer as count, coalesce(extract(epoch from clock_timestamp() - min(due)), 0)::float8 as age
					from (select next_reset_at as due from license_meters where next_reset_at <= clock_timestamp() order by next_reset_at limit ${limit}) rows
					union all select 'receipts', count(*)::integer, coalesce(extract(epoch from clock_timestamp() - min(due)), 0)::float8
					from (select expires_at as due from idempotency_receipts where expires_at <= clock_timestamp() order by expires_at limit ${limit}) rows
					union all select 'webhooks', count(*)::integer, coalesce(extract(epoch from clock_timestamp() - min(due)), 0)::float8
					from (select created_at as due from webhook_deliveries where state in ('succeeded','failed','cancelled') and created_at < clock_timestamp() - ${settings.webhookHistoryDays}::integer * interval '1 day' order by created_at limit ${limit}) rows`);
					const retained = await tx.execute<{
						name: RetainedTable;
						rows: number;
						bytes: string;
					}>(sql`
					select tables.name, greatest(c.reltuples, 0)::float8 as rows, pg_total_relation_size(c.oid)::text as bytes
					from (values ('events', 'activity_events'), ('audits', 'audit_logs'), ('accepted_usage', 'usage_operations'),
					('receipts', 'idempotency_receipts'), ('webhook_deliveries', 'webhook_deliveries'), ('webhook_attempts', 'webhook_delivery_attempts')) tables(name, relation)
					join pg_class c on c.oid = to_regclass('public.' || tables.relation)`);
					return { backlogs, retained };
				},
				"none",
				Date.now() + this.budgets.observationTimeMs,
			);
			for (const row of sample.backlogs) {
				metrics.setGauge(`keyzori_cleanup_${row.kind}_backlog`, row.count);
				metrics.setGauge(
					`keyzori_cleanup_${row.kind}_oldest_seconds`,
					Math.max(0, row.age),
				);
			}
			for (const row of sample.retained)
				metrics.retention(row.name, row.rows, Number(row.bytes));
			metrics.setGauge("keyzori_cleanup_backlog_sample_limit", limit);
			metrics.setGauge(
				"keyzori_cleanup_observed_at_seconds",
				Date.now() / 1000,
			);
		} catch (error) {
			this.logger?.write("warn", "maintenance.observation.failed", {
				phase: "maintenance_observation",
				cause: Logger.cause(error),
			});
		}
	}
}
