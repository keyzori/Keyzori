import { and, asc, inArray, lte, sql } from "drizzle-orm";
import { licenses } from "./database/schema/licenses";
import { meters } from "./database/schema/meters";
import { receipts } from "./database/schema/receipts";
import { deliveries } from "./database/schema/deliveries";
import type { Database } from "./database/Database";
import type { MeterService } from "../plugins/licenses/MeterService";
import type { SettingsService } from "../plugins/settings/SettingsService";

export class MaintenanceService {
	constructor(
		private readonly database: Database,
		private readonly metering: MeterService,
		private readonly settings: SettingsService,
	) {}
	async runOnce() {
		return this.database.transaction(async (tx) => {
			const [lock] = await tx
				.select({
					acquired: sql<boolean>`pg_try_advisory_xact_lock(6284, 2)`,
					now: sql<Date>`clock_timestamp()`,
				})
				.from(sql`(values (1)) as maintenance`);
			if (!lock?.acquired) return false;
			const due = tx
				.select({ id: meters.licenseId })
				.from(meters)
				.where(lte(meters.nextResetAt, lock.now));
			const rows = await tx
				.select({ id: licenses.id })
				.from(licenses)
				.where(inArray(licenses.id, due))
				.orderBy(asc(licenses.id))
				.limit(100)
				.for("update", { skipLocked: true });
			for (const row of rows)
				await this.metering.effective(
					tx,
					row.id,
					{
						actor: { kind: "system", id: "maintenance", name: "Maintenance" },
						action: "meter.reset",
						targetType: "license",
						targetId: row.id,
						requestId: Bun.randomUUIDv7(),
						clientIp: "",
					},
					lock.now,
				);
			await tx.execute(
				sql`delete from ${receipts} where ctid in (select ctid from ${receipts} where ${receipts.expiresAt} <= ${lock.now} limit 1000 for update skip locked)`,
			);
			const settings = await this.settings.read(tx);
			if (settings.webhookHistoryDays !== null) {
				const cutoff = new Date(
					lock.now.getTime() - settings.webhookHistoryDays * 86400000,
				);
				const expired = tx
					.select({ id: deliveries.id })
					.from(deliveries)
					.where(
						and(
							lte(deliveries.createdAt, cutoff),
							sql`${deliveries.state} <> 'pending'`,
						),
					)
					.limit(1000)
					.for("update", { skipLocked: true });
				await tx.delete(deliveries).where(inArray(deliveries.id, expired));
			}
			return true;
		});
	}
}
