import { and, asc, eq, gte } from "drizzle-orm";
import type {
	DeviceAllowlistEntry,
	IpAllowlistEntry,
} from "../../domain/entities";
import type {
	AccessAttemptIdentifier,
	AccessRecords,
	IAccessRepository,
} from "../../domain/repositories/IAccessRepository";
import type { Database } from "../../db";
import {
	activityEvents,
	licenseDeviceAllowlistEntries,
	licenseIpAllowlistEntries,
	registeredDevices,
} from "../../db/schema";

function summarizeAttempts(
	rows: Array<{
		ip: string | null;
		deviceId: string | null;
		details: Record<string, unknown>;
		createdAt: Date;
	}>,
	field: "ip" | "deviceId",
): AccessAttemptIdentifier[] {
	const summaries = new Map<string, AccessAttemptIdentifier>();
	for (const row of rows) {
		const value = row[field];
		if (!value) continue;
		const storedCount = row.details.attemptCount;
		const attemptCount =
			typeof storedCount === "number" && Number.isInteger(storedCount)
				? Math.max(1, storedCount)
				: 1;
		const storedFirstAttempt = row.details.firstAttemptedAt;
		const parsedFirstAttempt =
			typeof storedFirstAttempt === "string" ||
			storedFirstAttempt instanceof Date
				? new Date(storedFirstAttempt)
				: row.createdAt;
		const firstAttemptedAt = Number.isNaN(parsedFirstAttempt.getTime())
			? row.createdAt
			: parsedFirstAttempt;
		const existing = summaries.get(value);
		if (existing) {
			existing.attemptCount += attemptCount;
			existing.lastAttemptedAt = row.createdAt;
			if (firstAttemptedAt < existing.firstAttemptedAt) {
				existing.firstAttemptedAt = firstAttemptedAt;
			}
		} else {
			summaries.set(value, {
				value,
				attemptCount,
				firstAttemptedAt,
				lastAttemptedAt: row.createdAt,
			});
		}
	}
	return [...summaries.values()].sort(
		(left, right) =>
			right.lastAttemptedAt.getTime() - left.lastAttemptedAt.getTime(),
	);
}

export class DrizzleAccessRepository implements IAccessRepository {
	constructor(
		private readonly db: Database,
		private readonly retentionDays = 30,
	) {
		if (!Number.isInteger(retentionDays) || retentionDays < 1) {
			throw new Error("Access activity retention days must be positive.");
		}
	}

	async getAccessRecords(licenseId: string): Promise<AccessRecords> {
		const retentionStart = new Date(
			Date.now() - this.retentionDays * 24 * 60 * 60 * 1_000,
		);
		const [allowedIps, allowedDevices, devices, attempts] = await Promise.all([
			this.db
				.select()
				.from(licenseIpAllowlistEntries)
				.where(eq(licenseIpAllowlistEntries.licenseId, licenseId)),
			this.db
				.select()
				.from(licenseDeviceAllowlistEntries)
				.where(eq(licenseDeviceAllowlistEntries.licenseId, licenseId)),
			this.db
				.select()
				.from(registeredDevices)
				.where(eq(registeredDevices.licenseId, licenseId)),
			this.db
				.select({
					ip: activityEvents.ip,
					deviceId: activityEvents.deviceId,
					details: activityEvents.details,
					createdAt: activityEvents.createdAt,
				})
				.from(activityEvents)
				.where(
					and(
						eq(activityEvents.licenseId, licenseId),
						eq(activityEvents.type, "license.activation_attempted"),
						gte(activityEvents.createdAt, retentionStart),
					),
				)
				.orderBy(asc(activityEvents.createdAt)),
		]);
		return {
			allowedIps,
			allowedDevices,
			registeredDevices: devices,
			attemptedIps: summarizeAttempts(attempts, "ip"),
			attemptedDevices: summarizeAttempts(attempts, "deviceId"),
		};
	}

	async addAllowedIp(licenseId: string, ip: string): Promise<IpAllowlistEntry> {
		const rows = await this.db
			.insert(licenseIpAllowlistEntries)
			.values({ id: crypto.randomUUID(), licenseId, ip })
			.onConflictDoNothing()
			.returning();
		const entry =
			rows[0] ??
			(
				await this.db
					.select()
					.from(licenseIpAllowlistEntries)
					.where(
						and(
							eq(licenseIpAllowlistEntries.licenseId, licenseId),
							eq(licenseIpAllowlistEntries.ip, ip),
						),
					)
					.limit(1)
			)[0];
		if (!entry) throw new Error("Allowed IP could not be stored.");
		return entry;
	}

	async removeAllowedIp(licenseId: string, ip: string): Promise<boolean> {
		const rows = await this.db
			.delete(licenseIpAllowlistEntries)
			.where(
				and(
					eq(licenseIpAllowlistEntries.licenseId, licenseId),
					eq(licenseIpAllowlistEntries.ip, ip),
				),
			)
			.returning({ id: licenseIpAllowlistEntries.id });
		return rows.length > 0;
	}

	async addAllowedDevice(
		licenseId: string,
		deviceId: string,
	): Promise<DeviceAllowlistEntry> {
		const rows = await this.db
			.insert(licenseDeviceAllowlistEntries)
			.values({ id: crypto.randomUUID(), licenseId, deviceId })
			.onConflictDoNothing()
			.returning();
		const entry =
			rows[0] ??
			(
				await this.db
					.select()
					.from(licenseDeviceAllowlistEntries)
					.where(
						and(
							eq(licenseDeviceAllowlistEntries.licenseId, licenseId),
							eq(licenseDeviceAllowlistEntries.deviceId, deviceId),
						),
					)
					.limit(1)
			)[0];
		if (!entry) throw new Error("Allowed device could not be stored.");
		return entry;
	}

	async removeAllowedDevice(
		licenseId: string,
		deviceId: string,
	): Promise<boolean> {
		const rows = await this.db
			.delete(licenseDeviceAllowlistEntries)
			.where(
				and(
					eq(licenseDeviceAllowlistEntries.licenseId, licenseId),
					eq(licenseDeviceAllowlistEntries.deviceId, deviceId),
				),
			)
			.returning({ id: licenseDeviceAllowlistEntries.id });
		return rows.length > 0;
	}
}
