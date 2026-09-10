import { and, count, eq, sql } from "drizzle-orm";
import type { Executor } from "../database/Database.ts";
import type { Page } from "../shared/schemas.ts";
import {
	devices,
	ips,
	deviceAllowlist,
	ipAllowlist,
	licenseBlocks,
} from "./tables.ts";
import type { licenses } from "../licenses/tables.ts";
import { AppError, required } from "../shared/errors.ts";

export class AccessRepository {
	constructor(private readonly db: Executor) {}
	async block(
		tx: Executor,
		licenseId: string,
		source: string,
		reason: string | null,
	) {
		if (reason === null)
			await tx
				.delete(licenseBlocks)
				.where(
					and(
						eq(licenseBlocks.licenseId, licenseId),
						eq(licenseBlocks.source, source),
					),
				);
		else
			await tx
				.insert(licenseBlocks)
				.values({ licenseId, source, reason })
				.onConflictDoUpdate({
					target: [licenseBlocks.licenseId, licenseBlocks.source],
					set: { reason },
				});
	}
	async allowlists(licenseId: string, tx = this.db) {
		return {
			devices: await tx
				.select({ fingerprint: deviceAllowlist.fingerprint })
				.from(deviceAllowlist)
				.where(eq(deviceAllowlist.licenseId, licenseId)),
			networks: await tx
				.select({ network: ipAllowlist.network })
				.from(ipAllowlist)
				.where(eq(ipAllowlist.licenseId, licenseId)),
		};
	}
	async replaceAllowlists(
		tx: Executor,
		licenseId: string,
		fingerprints: string[],
		networks: string[],
	) {
		await tx
			.delete(deviceAllowlist)
			.where(eq(deviceAllowlist.licenseId, licenseId));
		await tx.delete(ipAllowlist).where(eq(ipAllowlist.licenseId, licenseId));
		if (fingerprints.length)
			await tx
				.insert(deviceAllowlist)
				.values(fingerprints.map((fingerprint) => ({ licenseId, fingerprint })))
				.onConflictDoNothing();
		if (networks.length)
			await tx
				.insert(ipAllowlist)
				.values(networks.map((network) => ({ licenseId, network })))
				.onConflictDoNothing();
	}
	async admit(
		tx: Executor,
		license: typeof licenses.$inferSelect,
		fingerprint: string,
		address: string,
	) {
		const id = license.id;
		if (
			license.deviceAllowlistEnabled &&
			!(
				await tx
					.select()
					.from(deviceAllowlist)
					.where(
						and(
							eq(deviceAllowlist.licenseId, id),
							eq(deviceAllowlist.fingerprint, fingerprint),
						),
					)
					.limit(1)
			).length
		)
			throw new AppError(
				"DEVICE_NOT_ALLOWED",
				"Device is not allowlisted.",
				403,
			);
		if (
			license.ipAllowlistEnabled &&
			!(
				await tx
					.select()
					.from(ipAllowlist)
					.where(
						and(
							eq(ipAllowlist.licenseId, id),
							sql`${ipAllowlist.network} >>= ${address}::inet`,
						),
					)
					.limit(1)
			).length
		)
			throw new AppError("IP_NOT_ALLOWED", "IP is not allowlisted.", 403);
		const device = (
			await tx
				.select()
				.from(devices)
				.where(
					and(eq(devices.licenseId, id), eq(devices.fingerprint, fingerprint)),
				)
		)[0];
		const ip = (
			await tx
				.select()
				.from(ips)
				.where(and(eq(ips.licenseId, id), eq(ips.address, address)))
		)[0];
		if (device?.blocked || ip?.blocked)
			throw new AppError(
				"ACCESS_BLOCKED",
				"Device or IP access is blocked.",
				403,
			);
		if (!device) {
			const total = required(
				(
					await tx
						.select({ value: count() })
						.from(devices)
						.where(eq(devices.licenseId, id))
				)[0],
			).value;
			if (total >= license.maxDevices)
				throw new AppError(
					"DEVICE_LIMIT",
					"Registered device limit reached.",
					409,
				);
			await tx.insert(devices).values({ licenseId: id, fingerprint });
		}
		if (!ip) {
			const total = required(
				(
					await tx
						.select({ value: count() })
						.from(ips)
						.where(eq(ips.licenseId, id))
				)[0],
			).value;
			if (total >= license.maxIps)
				throw new AppError("IP_LIMIT", "Registered IP limit reached.", 409);
			await tx.insert(ips).values({ licenseId: id, address });
		}
	}
	listDevices(licenseId: string, page: Page) {
		return this.db
			.select()
			.from(devices)
			.where(eq(devices.licenseId, licenseId))
			.orderBy(devices.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	listIps(licenseId: string, page: Page) {
		return this.db
			.select()
			.from(ips)
			.where(eq(ips.licenseId, licenseId))
			.orderBy(ips.id)
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	async device(
		tx: Executor,
		licenseId: string,
		id: string,
		blocked: boolean | null,
	) {
		const where = and(eq(devices.licenseId, licenseId), eq(devices.id, id));
		return required(
			(
				await (blocked === null
					? tx.delete(devices).where(where).returning()
					: tx.update(devices).set({ blocked }).where(where).returning())
			)[0],
			"Device",
		);
	}
	async ip(
		tx: Executor,
		licenseId: string,
		id: string,
		blocked: boolean | null,
	) {
		const where = and(eq(ips.licenseId, licenseId), eq(ips.id, id));
		return required(
			(
				await (blocked === null
					? tx.delete(ips).where(where).returning()
					: tx.update(ips).set({ blocked }).where(where).returning())
			)[0],
			"IP",
		);
	}
}
