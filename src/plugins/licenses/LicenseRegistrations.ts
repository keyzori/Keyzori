import { and, eq, inArray } from "drizzle-orm";
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
		const address = input.ip
			? await this.ip.normalize(input.ip, operation.deadlineAt)
			: undefined;
		return this.idempotency.admin(
			operation,
			`license.${kind}.register`,
			input,
			async (tx) => {
				const [license] = await this.context.lock(tx, [input.licenseId]);
				if (!license) throw new HttpError("NOT_FOUND");
				const evidence = this.context.evidence(operation, license.id);
				if (kind === "device" && input.hardwareId) {
					const existing = await tx
						.select({ hardwareId: hardware.hardwareId })
						.from(hardware)
						.where(eq(hardware.licenseId, license.id));
					if (!existing.some((row) => row.hardwareId === input.hardwareId)) {
						if (existing.length >= Math.min(license.deviceLimit ?? 1000, 1000))
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
				} else if (address) {
					const existing = await tx
						.select({ ip: ips.ip })
						.from(ips)
						.where(eq(ips.licenseId, license.id));
					if (!existing.some((row) => row.ip === address)) {
						if (existing.length >= Math.min(license.ipLimit ?? 1000, 1000))
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
				authorize: (tx) =>
					this.context.authorize(tx, operation, scope, [input.licenseId]),
			},
		);
	}

	async removeHardware(input: $HardwareRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "devices:remove");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.hardware.remove",
			input,
			async (tx) => {
				for (const row of await this.context.lock(tx, ids)) {
					const removed = await tx
						.delete(hardware)
						.where(
							and(
								eq(hardware.licenseId, row.id),
								inArray(hardware.hardwareId, input.hardwareIds),
							),
						)
						.returning();
					if (removed.length)
						await this.audit.record(tx, {
							...this.context.evidence(operation, row.id, input.reason),
							action: "license.hardware.removed",
							before: { hardwareIds: removed.map((entry) => entry.hardwareId) },
						});
				}
				return { data: { ids } };
			},
			{
				authorize: (tx) =>
					this.context.authorize(tx, operation, "devices:remove", ids),
			},
		);
	}

	async removeIps(input: $IpRemoval, operation: $Operation) {
		this.auth.require(operation.principal, "ips:remove");
		const ids = this.input.ids(input.ids);
		const addresses: string[] = [];
		for (const address of input.ips)
			addresses.push(await this.ip.normalize(address, operation.deadlineAt));
		return this.idempotency.admin(
			operation,
			"license.ips.remove",
			input,
			async (tx) => {
				for (const row of await this.context.lock(tx, ids)) {
					const removed = await tx
						.delete(ips)
						.where(and(eq(ips.licenseId, row.id), inArray(ips.ip, addresses)))
						.returning();
					if (removed.length)
						await this.audit.record(tx, {
							...this.context.evidence(operation, row.id, input.reason),
							action: "license.ips.removed",
							before: { ips: removed.map((entry) => entry.ip) },
						});
				}
				return { data: { ids } };
			},
			{
				authorize: (tx) =>
					this.context.authorize(tx, operation, "ips:remove", ids),
			},
		);
	}
}
