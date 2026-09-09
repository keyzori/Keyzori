import { and, countDistinct, eq, isNull, sql } from "drizzle-orm";
import type { License, RegisteredDevice } from "../../domain/entities";
import type {
	IDeviceRepository,
	LicenseDeviceUsage,
} from "../../domain/repositories/IDeviceRepository";
import type { LicenseWithAllowlists } from "../../domain/repositories/ILicenseRepository";
import type { Database } from "../../db";
import {
	licenseDeviceAllowlistEntries,
	licenseIpAllowlistEntries,
	licenses,
	registeredDevices,
	stripeSubscriptionLinks,
} from "../../db/schema";

type DatabaseTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];
type DeviceDatabase = Database | DatabaseTransaction;

export class DrizzleDeviceRepository implements IDeviceRepository {
	private readonly db: DeviceDatabase;
	private readonly transactionRunner: Database | null;

	constructor(db: DeviceDatabase, transactionRunner?: Database | null) {
		this.db = db;
		this.transactionRunner =
			transactionRunner === undefined ? (db as Database) : transactionRunner;
	}

	async withLicenseRegistrationLock<T>(
		licenseId: string,
		operation: (repository: IDeviceRepository) => Promise<T>,
	): Promise<T> {
		if (!this.transactionRunner) return await operation(this);
		return await this.transactionRunner.transaction(async (transaction) => {
			await transaction.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${licenseId}, 0))`,
			);
			return await operation(new DrizzleDeviceRepository(transaction, null));
		});
	}

	async findLicenseAdmissionPolicy(
		licenseId: string,
	): Promise<LicenseWithAllowlists | null> {
		const rows = await this.db
			.select()
			.from(licenses)
			.where(eq(licenses.id, licenseId))
			.limit(1)
			.for("update");
		const stored = rows[0];
		if (!stored) return null;
		const billingRows = await this.db
			.select({ billingRevokedAt: stripeSubscriptionLinks.billingRevokedAt })
			.from(stripeSubscriptionLinks)
			.where(eq(stripeSubscriptionLinks.licenseId, licenseId))
			.limit(1);
		const allowedIps = await this.db
			.select()
			.from(licenseIpAllowlistEntries)
			.where(eq(licenseIpAllowlistEntries.licenseId, licenseId));
		const allowedDevices = await this.db
			.select()
			.from(licenseDeviceAllowlistEntries)
			.where(eq(licenseDeviceAllowlistEntries.licenseId, licenseId));
		const { keyHash: _keyHash, ...license } = stored;
		return {
			...(license as License),
			billingRevokedAt: billingRows[0]?.billingRevokedAt ?? null,
			allowedIps,
			allowedDevices,
		};
	}

	async incrementLicenseSessionRevision(
		licenseId: string,
	): Promise<number | null> {
		const rows = await this.db
			.update(licenses)
			.set({
				sessionRevision: sql`${licenses.sessionRevision} + 1`,
				updatedAt: sql`greatest(clock_timestamp()::timestamp, ${licenses.updatedAt} + interval '1 millisecond')`,
			})
			.where(eq(licenses.id, licenseId))
			.returning({ sessionRevision: licenses.sessionRevision });
		return rows[0]?.sessionRevision ?? null;
	}

	async startTrialIfUnset(
		licenseId: string,
		startedAt: Date,
	): Promise<Date | null> {
		const rows = await this.db
			.update(licenses)
			.set({
				trialStartedAt: startedAt,
				updatedAt: sql`greatest(clock_timestamp()::timestamp, ${licenses.updatedAt} + interval '1 millisecond')`,
			})
			.where(
				and(
					eq(licenses.id, licenseId),
					eq(licenses.type, "trial"),
					isNull(licenses.trialStartedAt),
				),
			)
			.returning({ trialStartedAt: licenses.trialStartedAt });
		return rows[0]?.trialStartedAt ?? null;
	}

	async findRegisteredDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice | null> {
		const rows = await this.db
			.select()
			.from(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.ip, ip),
					eq(registeredDevices.deviceId, deviceId),
				),
			)
			.limit(1);
		return rows[0] ?? null;
	}

	async registerDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice> {
		const now = new Date();
		const rows = await this.db
			.insert(registeredDevices)
			.values({
				id: crypto.randomUUID(),
				licenseId,
				ip,
				deviceId,
				lastSeenAt: now,
			})
			.onConflictDoUpdate({
				target: [
					registeredDevices.licenseId,
					registeredDevices.ip,
					registeredDevices.deviceId,
				],
				set: { lastSeenAt: now },
			})
			.returning();
		const device = rows[0];
		if (!device) throw new Error("Database returned no registered device.");
		return device;
	}

	async touchDevice(id: string, seenAt: Date): Promise<void> {
		await this.db
			.update(registeredDevices)
			.set({ lastSeenAt: seenAt })
			.where(eq(registeredDevices.id, id));
	}

	async getLicenseDeviceUsage(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<LicenseDeviceUsage> {
		const counts = await this.db
			.select({
				uniqueIps: countDistinct(registeredDevices.ip),
				uniqueDevices: countDistinct(registeredDevices.deviceId),
			})
			.from(registeredDevices)
			.where(eq(registeredDevices.licenseId, licenseId));
		const ipRows = await this.db
			.select({ id: registeredDevices.id })
			.from(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.ip, ip),
				),
			)
			.limit(1);
		const deviceRows = await this.db
			.select({ id: registeredDevices.id })
			.from(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.deviceId, deviceId),
				),
			)
			.limit(1);
		return {
			uniqueIps: counts[0]?.uniqueIps ?? 0,
			uniqueDevices: counts[0]?.uniqueDevices ?? 0,
			ipRegistered: ipRows.length > 0,
			deviceRegistered: deviceRows.length > 0,
		};
	}

	async removeRegisteredDevice(
		licenseId: string,
		registeredDeviceId: string,
	): Promise<boolean> {
		const rows = await this.db
			.delete(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.id, registeredDeviceId),
				),
			)
			.returning({ id: registeredDevices.id });
		return rows.length > 0;
	}

	async resetRegisteredDevices(licenseId: string): Promise<number> {
		const rows = await this.db
			.delete(registeredDevices)
			.where(eq(registeredDevices.licenseId, licenseId))
			.returning({ id: registeredDevices.id });
		return rows.length;
	}

	async removeRegistrationsByIp(
		licenseId: string,
		ip: string,
	): Promise<number> {
		const rows = await this.db
			.delete(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.ip, ip),
				),
			)
			.returning({ id: registeredDevices.id });
		return rows.length;
	}

	async removeRegistrationsByDevice(
		licenseId: string,
		deviceId: string,
	): Promise<number> {
		const rows = await this.db
			.delete(registeredDevices)
			.where(
				and(
					eq(registeredDevices.licenseId, licenseId),
					eq(registeredDevices.deviceId, deviceId),
				),
			)
			.returning({ id: registeredDevices.id });
		return rows.length;
	}
}
