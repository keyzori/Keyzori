import { and, eq, inArray, sql } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { AuthService } from "../../core/auth/AuthService";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { AuditService } from "../audits/AuditService";
import type { LicenseContext } from "./LicenseContext";
import type {
	$HardwareRemoval,
	$IpRemoval,
	$Registration,
} from "../../types/licenses";
import type { $Operation } from "../../types/operation";

/** Device/IP registration changes share the licence's transactional authority. */
export class LicenseRegistrations {
	private readonly input = new InputPolicy();
	constructor(
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly idempotency: IdempotencyService,
		private readonly ip: ClientIpResolver,
		private readonly context: LicenseContext,
	) {}

	async register(
		input: $Registration,
		operation: $Operation,
		kind: "device" | "ip",
	) {
		const scope = kind === "device" ? "devices:register" : "ips:register";
		this.auth.require(operation.principal, scope);
		if (
			kind === "device"
				? !input.hardwareId || input.ip !== undefined
				: !input.ip || input.hardwareId !== undefined
		)
			throw new HttpError("INVALID_REQUEST");
		const targets = this.context.targets(operation, scope, [input.licenseId], {
			id: licenses.id,
			groupId: licenses.groupId,
			deviceLimit: licenses.deviceLimit,
			ipLimit: licenses.ipLimit,
		});
		return this.idempotency.admin(
			operation,
			`license.${kind}.register`,
			input,
			async (tx) => {
				const [license] = targets.state(tx).rows;
				if (!license) throw new HttpError("NOT_FOUND");
				const evidence = {
					...this.context.evidence(operation, license.id),
					groupId: license.groupId,
				};
				if (kind === "device" && input.hardwareId) {
					const [existing] = await tx
						.select({
							count: sql<number>`count(*)::int`,
							known: sql<boolean>`coalesce(bool_or(${hardware.hardwareId} = ${input.hardwareId}), false)`,
						})
						.from(hardware)
						.where(eq(hardware.licenseId, license.id));
					if (!existing) throw new Error("Missing device capacity");
					if (!existing.known) {
						if (existing.count >= (license.deviceLimit ?? 1000))
							throw new HttpError("CONFLICT", {
								hardwareId: "Device registration limit reached",
							});
						await tx.insert(hardware).values({
							id: Bun.randomUUIDv7(),
							licenseId: license.id,
							hardwareId: input.hardwareId,
						});
						await this.audit.record(tx, {
							...evidence,
							action: "license.hardware.registered",
							after: { hardwareId: input.hardwareId },
						});
					}
				} else if (input.ip) {
					const [address] = await this.ip.normalizeMany(tx, [input.ip]);
					if (!address) throw new Error("Missing normalized address");
					const [existing] = await tx
						.select({
							count: sql<number>`count(*)::int`,
							known: sql<boolean>`coalesce(bool_or(${ips.ip} = ${address}::inet), false)`,
						})
						.from(ips)
						.where(eq(ips.licenseId, license.id));
					if (!existing) throw new Error("Missing IP capacity");
					if (!existing.known) {
						if (existing.count >= (license.ipLimit ?? 1000))
							throw new HttpError("CONFLICT", {
								ip: "IP registration limit reached",
							});
						await tx.insert(ips).values({
							id: Bun.randomUUIDv7(),
							licenseId: license.id,
							ip: address,
						});
						await this.audit.record(tx, {
							...evidence,
							action: "license.ips.registered",
							after: { ip: address },
						});
					}
				}
				return { data: { ids: [license.id] } };
			},
			{
				authorize: targets.authorize,
			},
		);
	}

	async removeHardware(input: $HardwareRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "devices:remove");
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(operation, "devices:remove", ids, {
			id: licenses.id,
			groupId: licenses.groupId,
		});
		return this.idempotency.admin(
			operation,
			"license.hardware.remove",
			input,
			async (tx) => {
				for (const row of targets.state(tx).rows) {
					const removed = await tx
						.delete(hardware)
						.where(
							and(
								eq(hardware.licenseId, row.id),
								inArray(hardware.hardwareId, input.hardwareIds),
							),
						)
						.returning({ hardwareId: hardware.hardwareId });
					if (removed.length)
						await this.audit.record(tx, {
							...this.context.evidence(operation, row.id, input.reason),
							groupId: row.groupId,
							action: "license.hardware.removed",
							before: { hardwareIds: removed.map((entry) => entry.hardwareId) },
						});
				}
				return { data: { ids } };
			},
			{
				authorize: targets.authorize,
			},
		);
	}

	async removeIps(input: $IpRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "ips:remove");
		const ids = this.input.ids(input.ids);
		const targets = this.context.targets(operation, "ips:remove", ids, {
			id: licenses.id,
			groupId: licenses.groupId,
		});
		return this.idempotency.admin(
			operation,
			"license.ips.remove",
			input,
			async (tx) => {
				const addresses = [
					...new Set(await this.ip.normalizeMany(tx, input.ips)),
				];
				for (const row of targets.state(tx).rows) {
					const removed = await tx
						.delete(ips)
						.where(and(eq(ips.licenseId, row.id), inArray(ips.ip, addresses)))
						.returning({ ip: ips.ip });
					if (removed.length)
						await this.audit.record(tx, {
							...this.context.evidence(operation, row.id, input.reason),
							groupId: row.groupId,
							action: "license.ips.removed",
							before: { ips: removed.map((entry) => entry.ip) },
						});
				}
				return { data: { ids } };
			},
			{
				authorize: targets.authorize,
			},
		);
	}
}
