import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { MAX_LICENSE_LIMIT } from "../../domain/licenseLimits";
import { hashUsageEventId } from "../../domain/usageEvent";
import type { LicenseMeter, UsageLedgerEntry } from "../../domain/entities";
import type {
	IMeterRepository,
	MeterAdjustmentResult,
	UsageConsumptionResult,
} from "../../domain/repositories/IMeterRepository";
import type { Database } from "../../db";
import { licenses, licenseMeters, usageLedgerEntries } from "../../db/schema";

type DatabaseTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

async function lockLicense(
	transaction: DatabaseTransaction,
	licenseId: string,
): Promise<void> {
	await transaction.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`meter:${licenseId}`}, 0))`,
	);
}

export class DrizzleMeterRepository implements IMeterRepository {
	constructor(private readonly db: Database) {}

	async listMeters(
		licenseId: string,
		includeArchived = false,
	): Promise<LicenseMeter[]> {
		return await this.db
			.select()
			.from(licenseMeters)
			.where(
				includeArchived
					? eq(licenseMeters.licenseId, licenseId)
					: and(
							eq(licenseMeters.licenseId, licenseId),
							isNull(licenseMeters.archivedAt),
						),
			)
			.orderBy(licenseMeters.name);
	}

	async createMeter(
		licenseId: string,
		name: string,
		balance: number,
		reason: string,
	): Promise<LicenseMeter> {
		return await this.db.transaction(async (transaction) => {
			await lockLicense(transaction, licenseId);
			const now = new Date();
			const rows = await transaction
				.insert(licenseMeters)
				.values({
					id: crypto.randomUUID(),
					licenseId,
					name,
					balance,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			const meter = rows[0];
			if (!meter) throw new Error("Database returned no created meter.");
			await transaction.insert(usageLedgerEntries).values({
				id: crypto.randomUUID(),
				licenseId,
				meterId: meter.id,
				eventId: `operator:${crypto.randomUUID()}`,
				kind: "create",
				delta: balance,
				balanceBefore: 0,
				balanceAfter: balance,
				reason,
				createdAt: now,
			});
			return meter;
		});
	}

	async archiveMeter(
		licenseId: string,
		name: string,
		reason: string,
	): Promise<LicenseMeter | null> {
		return await this.db.transaction(async (transaction) => {
			await lockLicense(transaction, licenseId);
			const licenseRows = await transaction
				.select({ type: licenses.type })
				.from(licenses)
				.where(eq(licenses.id, licenseId))
				.limit(1)
				.for("update");
			const license = licenseRows[0];
			if (!license) return null;
			if (license.type === "metered") {
				const activeMeters = await transaction
					.select()
					.from(licenseMeters)
					.where(
						and(
							eq(licenseMeters.licenseId, licenseId),
							isNull(licenseMeters.archivedAt),
						),
					);
				const target = activeMeters.find((meter) => meter.name === name);
				if (target && activeMeters.length === 1) return target;
			}
			const now = new Date();
			const rows = await transaction
				.update(licenseMeters)
				.set({ archivedAt: now, updatedAt: now })
				.where(
					and(
						eq(licenseMeters.licenseId, licenseId),
						eq(licenseMeters.name, name),
						isNull(licenseMeters.archivedAt),
					),
				)
				.returning();
			if (rows[0]) {
				const archived = rows[0];
				await transaction.insert(usageLedgerEntries).values({
					id: crypto.randomUUID(),
					licenseId,
					meterId: archived.id,
					eventId: `operator:${crypto.randomUUID()}`,
					kind: "archive",
					delta: 0,
					balanceBefore: archived.balance,
					balanceAfter: archived.balance,
					reason,
					createdAt: now,
				});
				return archived;
			}
			const existing = await transaction
				.select()
				.from(licenseMeters)
				.where(
					and(
						eq(licenseMeters.licenseId, licenseId),
						eq(licenseMeters.name, name),
					),
				)
				.limit(1);
			return existing[0] ?? null;
		});
	}

	async consume(
		licenseId: string,
		meterName: string,
		units: number,
		eventId: string,
	): Promise<UsageConsumptionResult> {
		const eventIdHash = hashUsageEventId(eventId);
		return await this.db.transaction(async (transaction) => {
			await lockLicense(transaction, licenseId);
			const existingRows = await transaction
				.select({ entry: usageLedgerEntries, meter: licenseMeters })
				.from(usageLedgerEntries)
				.innerJoin(
					licenseMeters,
					eq(licenseMeters.id, usageLedgerEntries.meterId),
				)
				.where(
					and(
						eq(usageLedgerEntries.licenseId, licenseId),
						eq(usageLedgerEntries.eventId, eventIdHash),
					),
				)
				.limit(1);
			const existing = existingRows[0];
			if (existing) {
				if (
					existing.entry.kind !== "consume" ||
					existing.entry.delta !== -units ||
					existing.meter.name !== meterName
				) {
					return { status: "conflict" };
				}
				return {
					status: "replayed",
					meter: { ...existing.meter, balance: existing.entry.balanceAfter },
					entry: existing.entry,
				};
			}

			const meterRows = await transaction
				.select()
				.from(licenseMeters)
				.where(
					and(
						eq(licenseMeters.licenseId, licenseId),
						eq(licenseMeters.name, meterName),
					),
				)
				.limit(1);
			const meter = meterRows[0];
			if (!meter) return { status: "not-found" };
			if (meter.archivedAt) return { status: "archived" };

			const now = new Date();
			const updatedRows = await transaction
				.update(licenseMeters)
				.set({
					balance: sql`${licenseMeters.balance} - ${units}`,
					updatedAt: now,
				})
				.where(
					and(
						eq(licenseMeters.id, meter.id),
						gte(licenseMeters.balance, units),
					),
				)
				.returning();
			const updated = updatedRows[0];
			if (!updated) return { status: "exhausted" };
			const entryRows = await transaction
				.insert(usageLedgerEntries)
				.values({
					id: crypto.randomUUID(),
					licenseId,
					meterId: meter.id,
					eventId: eventIdHash,
					kind: "consume",
					delta: -units,
					balanceBefore: updated.balance + units,
					balanceAfter: updated.balance,
					createdAt: now,
				})
				.returning();
			const entry = entryRows[0];
			if (!entry) throw new Error("Usage ledger entry was not created.");
			return { status: "consumed", meter: updated, entry };
		});
	}

	async adjust(
		licenseId: string,
		meterName: string,
		delta: number,
		reason: string,
		kind: "top_up" | "adjustment",
	): Promise<MeterAdjustmentResult> {
		return await this.db.transaction(async (transaction) => {
			await lockLicense(transaction, licenseId);
			const meterRows = await transaction
				.select()
				.from(licenseMeters)
				.where(
					and(
						eq(licenseMeters.licenseId, licenseId),
						eq(licenseMeters.name, meterName),
					),
				)
				.limit(1);
			const meter = meterRows[0];
			if (!meter) return { status: "not-found" };
			if (meter.archivedAt) return { status: "archived" };

			const bounds =
				delta > 0
					? lte(licenseMeters.balance, MAX_LICENSE_LIMIT - delta)
					: gte(licenseMeters.balance, -delta);
			const now = new Date();
			const updatedRows = await transaction
				.update(licenseMeters)
				.set({
					balance: sql`${licenseMeters.balance} + ${delta}`,
					updatedAt: now,
				})
				.where(and(eq(licenseMeters.id, meter.id), bounds))
				.returning();
			const updated = updatedRows[0];
			if (!updated) return { status: "out-of-range" };
			const entryRows = await transaction
				.insert(usageLedgerEntries)
				.values({
					id: crypto.randomUUID(),
					licenseId,
					meterId: meter.id,
					eventId: `operator:${crypto.randomUUID()}`,
					kind,
					delta,
					balanceBefore: updated.balance - delta,
					balanceAfter: updated.balance,
					reason,
					createdAt: now,
				})
				.returning();
			const entry = entryRows[0];
			if (!entry) throw new Error("Meter adjustment was not recorded.");
			return { status: "adjusted", meter: updated, entry };
		});
	}

	async listLedger(
		licenseId: string,
		meterName?: string,
	): Promise<UsageLedgerEntry[]> {
		const filter = meterName
			? and(
					eq(usageLedgerEntries.licenseId, licenseId),
					eq(licenseMeters.name, meterName),
				)
			: eq(usageLedgerEntries.licenseId, licenseId);
		const rows = await this.db
			.select({ entry: usageLedgerEntries })
			.from(usageLedgerEntries)
			.innerJoin(
				licenseMeters,
				eq(licenseMeters.id, usageLedgerEntries.meterId),
			)
			.where(filter)
			.orderBy(desc(usageLedgerEntries.createdAt));
		return rows.map((row) => row.entry);
	}
}
