import { and, eq, sql } from "drizzle-orm";
import { groups } from "../../core/database/schema/groups";
import { users } from "../../core/database/schema/users";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { Decision } from "./Decision";
import type { $Transaction } from "../../types/database";
import type { $License } from "../../types/licenses";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { SettingsService } from "../settings/SettingsService";

/** Pure eligibility checks; registrations and usage require explicit administrative operations. */
export class Eligibility {
	constructor(
		private readonly settings: SettingsService,
		private readonly ip: ClientIpResolver,
	) {}
	async check(
		tx: $Transaction,
		license: $License,
		input: {
			expectedGroupId?: string | null;
			userId?: string;
			hardwareId?: string;
		},
		clientIp: string,
		now: Date,
	): Promise<Decision> {
		if (!license.enabled)
			return new Decision("LICENSE_DISABLED", license.disabledReason);
		if (license.expiresAt && now >= license.expiresAt)
			return new Decision("LICENSE_EXPIRED");
		if (
			input.expectedGroupId !== undefined &&
			(input.expectedGroupId?.toLowerCase() ?? null) !== license.groupId
		)
			return new Decision("GROUP_NOT_ALLOWED");
		if (
			input.userId !== undefined &&
			input.userId.toLowerCase() !== license.userId
		)
			return new Decision("USER_NOT_ALLOWED");
		if (license.groupId) {
			const [group] = await tx
				.select()
				.from(groups)
				.where(eq(groups.id, license.groupId));
			if (!group?.enabled)
				return new Decision("GROUP_DISABLED", group?.disabledReason);
		}
		if (license.userId) {
			const [user] = await tx
				.select()
				.from(users)
				.where(eq(users.id, license.userId));
			if (!user?.enabled)
				return new Decision("USER_DISABLED", user?.disabledReason);
		}
		const settings = await this.settings.read(tx);
		if (await this.ip.matches(tx, clientIp, settings.globalDeniedIps))
			return new Decision("IP_BLOCKED");
		if (
			license.allowedIps.length &&
			!(await this.ip.matches(tx, clientIp, license.allowedIps))
		)
			return new Decision("IP_NOT_ALLOWED");
		if (license.deviceLimit !== null) {
			if (!input.hardwareId) return new Decision("HARDWARE_ID_REQUIRED");
			const [registered] = await tx
				.select({ id: hardware.id })
				.from(hardware)
				.where(
					and(
						eq(hardware.licenseId, license.id),
						eq(hardware.hardwareId, input.hardwareId),
					),
				);
			if (!registered || license.deviceLimit === 0)
				return new Decision("DEVICE_NOT_REGISTERED");
		}
		if (license.ipLimit !== null) {
			const [registered] = await tx
				.select({ id: ips.id })
				.from(ips)
				.where(
					and(
						eq(ips.licenseId, license.id),
						sql`${ips.ip} = ${clientIp}::inet`,
					),
				);
			if (!registered || license.ipLimit === 0)
				return new Decision("IP_NOT_REGISTERED");
		}
		return new Decision("VALID");
	}
}
