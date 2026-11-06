import { asc, eq } from "drizzle-orm";
import { groups } from "../../core/database/schema/groups";
import { users } from "../../core/database/schema/users";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { meters } from "../../core/database/schema/meters";
import type { $Transaction } from "../../types/database";
import type { $License, $LicenseAdmin } from "../../types/licenses";
import type { MeterService } from "./MeterService";

/** Full bearer-visible projection. Credential digests never leave storage. */
export class LicenseView {
	constructor(private readonly metering: MeterService) {}
	async read(
		tx: $Transaction,
		row: $License,
		now: Date,
	): Promise<$LicenseAdmin> {
		const [group] = row.groupId
			? await tx.select().from(groups).where(eq(groups.id, row.groupId))
			: [];
		const [user] = row.userId
			? await tx.select().from(users).where(eq(users.id, row.userId))
			: [];
		const counters = await tx
			.select()
			.from(meters)
			.where(eq(meters.licenseId, row.id))
			.orderBy(asc(meters.name));
		const devices = await tx
			.select({ hardwareId: hardware.hardwareId })
			.from(hardware)
			.where(eq(hardware.licenseId, row.id))
			.orderBy(asc(hardware.registrationOrder));
		const addresses = await tx
			.select({ ip: ips.ip })
			.from(ips)
			.where(eq(ips.licenseId, row.id))
			.orderBy(asc(ips.registrationOrder));
		const projected = await this.metering.projectMany(tx, counters, now);
		return {
			id: row.id,
			enabled: row.enabled,
			disabledReason: row.disabledReason,
			groupId: row.groupId,
			userId: row.userId,
			group: group
				? {
						id: group.id,
						name: group.name,
						enabled: group.enabled,
						metadata: group.metadata,
						notes: group.notes,
						disabledReason: group.disabledReason,
						keyFormat: group.keyFormat,
						createdBy: group.createdBy,
						updatedBy: group.updatedBy,
						createdAt: group.createdAt.toISOString(),
						updatedAt: group.updatedAt.toISOString(),
					}
				: null,
			user: user
				? {
						id: user.id,
						name: user.name,
						enabled: user.enabled,
						metadata: user.metadata,
						notes: user.notes,
						disabledReason: user.disabledReason,
						createdBy: user.createdBy,
						updatedBy: user.updatedBy,
						createdAt: user.createdAt.toISOString(),
						updatedAt: user.updatedAt.toISOString(),
					}
				: null,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			deviceLimit: row.deviceLimit,
			ipLimit: row.ipLimit,
			allowedIps: row.allowedIps,
			metadata: row.metadata,
			notes: row.notes,
			keyFormat: row.keyFormat,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			meters: projected,
			hardwareIds: devices.map((entry) => entry.hardwareId),
			registeredIps: addresses.map((entry) => entry.ip),
		};
	}
	async validation(tx: $Transaction, row: $License, now: Date) {
		const {
			notes: _notes,
			group,
			user,
			...license
		} = await this.read(tx, row, now);
		const publicGroup = group
			? (({ notes: _notes, ...value }) => value)(group)
			: null;
		const publicUser = user
			? (({ notes: _notes, ...value }) => value)(user)
			: null;
		return { ...license, group: publicGroup, user: publicUser };
	}
	summary(row: $License) {
		return {
			id: row.id,
			enabled: row.enabled,
			disabledReason: row.disabledReason,
			groupId: row.groupId,
			userId: row.userId,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}
