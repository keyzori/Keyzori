import { eq, sql, and } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { users } from "../../core/database/schema/users";
import { items } from "../../core/database/schema/items";
import { hardware } from "../../core/database/schema/hardware";
import { ips } from "../../core/database/schema/ips";
import { meters } from "../../core/database/schema/meters";
import { SecretHasher } from "../../core/security/SecretHasher";
import { InputPolicy } from "../../core/http/InputPolicy";
import { HttpError } from "../../core/http/HttpError";
import { Decision } from "./Decision";
import type { Database } from "../../core/database/Database";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { Redis } from "../../core/redis/Redis";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { AuditService } from "../audits/AuditService";
import type { FailureAuditService } from "../audits/FailureAuditService";
import type { SettingsService } from "../settings/SettingsService";
import type { MeterService } from "../licenses/MeterService";
import type { $ValidationInput } from "../../types/validation";
import type { $RequestContext } from "../../types/http";

export class ValidationService {
	private readonly hasher = new SecretHasher();
	constructor(
		private readonly database: Database,
		private readonly redis: Redis,
		private readonly settings: SettingsService,
		private readonly ip: ClientIpResolver,
		private readonly metering: MeterService,
		private readonly idempotency: IdempotencyService,
		private readonly audit: AuditService,
		private readonly failures: FailureAuditService,
	) {}
	async validate(
		input: $ValidationInput,
		context: $RequestContext & { idempotencyKey?: string },
	) {
		try {
			if (!(await this.redis.ping(context.deadlineAt)))
				throw new Error("Redis unavailable");
		} catch {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
		const usageChanging =
			input.usage !== undefined && Object.keys(input.usage).length > 0;
		const key = new InputPolicy().idempotency(
			context.idempotencyKey,
			usageChanging,
		);
		let licenseId: string | undefined;
		try {
			const result = await this.database.transaction(
				async (tx) => {
					const [license] = await tx
						.select()
						.from(licenses)
						.where(eq(licenses.keyHash, this.hasher.hash(input.license)))
						.for("update");
					if (!license) throw new Decision("LICENSE_INVALID");
					licenseId = license.id;
					const [clock] = await tx
						.select({ now: sql<Date>`clock_timestamp()` })
						.from(sql`(values (1)) as clock`);
					if (!clock) throw new Error("Database time unavailable");
					const now = clock.now;
					if (!license.enabled) throw new Decision("LICENSE_DISABLED");
					if (license.expiresAt && now >= license.expiresAt)
						throw new Decision("LICENSE_EXPIRED");
					if (license.userId) {
						if (input.userId && input.userId.toLowerCase() !== license.userId)
							throw new Decision("USER_NOT_ALLOWED");
						const [user] = await tx
							.select({ enabled: users.enabled })
							.from(users)
							.where(eq(users.id, license.userId));
						if (!user?.enabled) throw new Decision("USER_DISABLED");
					}
					if (license.itemId) {
						if (input.itemId && input.itemId.toLowerCase() !== license.itemId)
							throw new Decision("ITEM_NOT_ALLOWED");
						const [item] = await tx
							.select({ enabled: items.enabled })
							.from(items)
							.where(eq(items.id, license.itemId));
						if (!item?.enabled) throw new Decision("ITEM_DISABLED");
					}
					if (license.userId && !input.userId)
						throw new HttpError("USER_ID_REQUIRED");
					if (license.itemId && !input.itemId)
						throw new HttpError("ITEM_ID_REQUIRED");
					const { license: credential, ...body } = input;
					const fingerprintInput = {
						body,
						clientIp: context.clientIp,
						credentialHash: this.hasher.hash(credential),
					};
					const fingerprint = this.idempotency.fingerprint(fingerprintInput);
					const receipt =
						usageChanging && key
							? await this.idempotency.existing(
									tx,
									"validate",
									license.id,
									key,
									fingerprint,
									fingerprintInput,
								)
							: undefined;
					if (!receipt) {
						if (license.deviceLimit !== null && !input.hardwareId)
							throw new HttpError("HARDWARE_ID_REQUIRED");
						const definitions = await tx
							.select()
							.from(meters)
							.where(eq(meters.licenseId, license.id));
						this.metering.validateUsage(definitions, input.usage);
					}
					const settings = await this.settings.read(tx);
					if (
						await this.ip.matches(
							tx,
							context.clientIp,
							settings.globalDeniedIps,
						)
					)
						throw new Decision("IP_BLOCKED");
					if (
						license.allowedIps.length &&
						!(await this.ip.matches(tx, context.clientIp, license.allowedIps))
					)
						throw new Decision("IP_NOT_ALLOWED");
					if (receipt) {
						return new Decision("VALID").response();
					}
					const evidence = {
						...context,
						actor: {
							kind: "license" as const,
							id: license.id,
							name: "License",
						},
						targetType: "license",
						targetId: license.id,
						action: "license.validated",
						hardwareId: input.hardwareId,
					};
					if (license.ipLimit !== null) {
						const known = await tx
							.select()
							.from(ips)
							.where(eq(ips.licenseId, license.id));
						const [registered] = await tx
							.select({ id: ips.id })
							.from(ips)
							.where(
								and(
									eq(ips.licenseId, license.id),
									sql`${ips.ip} = ${context.clientIp}::inet`,
								),
							);
						if (!registered) {
							if (known.length >= license.ipLimit)
								throw new Decision("IP_LIMIT_REACHED");
							await tx.insert(ips).values({
								id: Bun.randomUUIDv7(),
								licenseId: license.id,
								ip: context.clientIp,
							});
							await this.audit.record(tx, {
								...evidence,
								action: "license.ip.registered",
								after: { ip: context.clientIp },
							});
						}
					}
					if (license.deviceLimit !== null && input.hardwareId) {
						const known = await tx
							.select()
							.from(hardware)
							.where(eq(hardware.licenseId, license.id));
						if (!known.some((row) => row.hardwareId === input.hardwareId)) {
							if (known.length >= license.deviceLimit)
								throw new Decision("DEVICE_LIMIT_REACHED");
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
					}
					const effective = await this.metering.effective(
						tx,
						license.id,
						evidence,
						now,
					);
					await this.metering.consume(
						tx,
						effective,
						input.usage,
						evidence,
						now,
					);
					const result = new Decision("VALID").response();
					if (usageChanging && key)
						await this.idempotency.save(tx, {
							operation: "validate",
							principalId: license.id,
							key,
							fingerprint,
							result,
							expiresAt: new Date(
								now.getTime() + settings.idempotencyRetentionSeconds * 1000,
							),
						});
					return result;
				},
				"read",
				context.deadlineAt,
			);
			return result;
		} catch (error) {
			if (!(error instanceof Decision)) throw error;
			await this.failures.record(
				error.code,
				licenseId,
				input.license,
				context,
				input.hardwareId,
			);
			return error.response();
		}
	}
}
