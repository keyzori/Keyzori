import { HttpError } from "../../core/http/HttpError";
import type { Database } from "../../core/database/Database";
import type { Redis } from "../../core/redis/Redis";
import type { AuditService } from "./AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { $ValidationCode } from "../../types/validation";
import type { $RequestContext } from "../../types/http";

export class FailureAuditService {
	constructor(
		private readonly database: Database,
		private readonly redis: Redis,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly settings: SettingsService,
	) {}
	async record(
		code: $ValidationCode,
		licenseId: string | undefined,
		credential: string,
		context: $RequestContext,
		hardwareId?: string,
	) {
		const settings = await this.settings.read(undefined, context.deadlineAt);
		const fingerprint = new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify([
					code,
					licenseId ??
						new Bun.CryptoHasher("sha256").update(credential).digest("hex"),
					context.clientIp,
					hardwareId,
				]),
			)
			.digest("hex");
		const countKey = `kz:failure:${fingerprint}`;
		const claimKey = `${countKey}:claim`;
		const token = Bun.randomUUIDv7();
		const claim = await this.redis
			.send(
				"EVAL",
				[
					"if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end if n>=tonumber(ARGV[2]) then redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[4]); redis.call('DEL',KEYS[1]); return 1 end return 0",
					"2",
					countKey,
					claimKey,
					String(settings.failureWindowSeconds),
					String(settings.failureThreshold),
					token,
					String(settings.failureCooldownSeconds),
				],
				context.deadlineAt,
			)
			.catch(() => {
				throw new HttpError("SERVICE_UNAVAILABLE");
			});
		if (claim !== 1) return;
		try {
			await this.database.transaction(
				async (tx) => {
					await this.audit.record(tx, {
						...context,
						actor: {
							kind: licenseId ? "license" : "anonymous",
							id: licenseId ?? null,
							name: licenseId ? "License" : null,
						},
						action: "validation.failed",
						targetType: "license",
						targetId: licenseId,
						hardwareId,
						after: { code },
					});
					await this.events.emit(tx, "validation.failed", {
						licenseId,
						code,
						clientIp: context.clientIp,
						hardwareId,
					});
				},
				"read",
				context.deadlineAt,
			);
		} catch {
			await this.redis
				.send(
					"EVAL",
					[
						"if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
						"1",
						claimKey,
						token,
					],
					context.deadlineAt,
				)
				.catch(() => undefined);
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
	}
}
