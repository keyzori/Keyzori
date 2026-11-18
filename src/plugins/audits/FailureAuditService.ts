import { HttpError } from "../../core/http/HttpError";
import type { Database } from "../../core/database/Database";
import type { Redis } from "../../core/redis/Redis";
import type { AuditService } from "./AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { $ValidationCode } from "../../types/validation";
import type { $RequestContext } from "../../types/http";

// The claim outlasts a bounded database transaction (14s). A crashed claimant
// leaves the threshold and its stable evidence ID available to the next one.
const leaseSeconds = 20;
const acquire = `
	if redis.call('EXISTS',KEYS[3]) == 1 then return 0 end
	local evidence = redis.call('HGET',KEYS[1],'evidence')
	if not evidence then
		local count = redis.call('HINCRBY',KEYS[1],'count',1)
		if count == 1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end
		if count < tonumber(ARGV[2]) then return 0 end
		evidence = ARGV[3]
		redis.call('HSET',KEYS[1],'evidence',evidence)
	end
	if not redis.call('SET',KEYS[2],ARGV[4],'NX','EX',ARGV[5]) then return 0 end
	redis.call('EXPIRE',KEYS[1],math.max(tonumber(ARGV[1]),tonumber(ARGV[5])*2,tonumber(ARGV[6])))
	return evidence`;
const acknowledge = `
	if redis.call('GET',KEYS[2]) ~= ARGV[1] or redis.call('HGET',KEYS[1],'evidence') ~= ARGV[2] then return 0 end
	redis.call('SET',KEYS[3],ARGV[2],'EX',ARGV[3])
	redis.call('DEL',KEYS[1],KEYS[2])
	return 1`;
const release = `
	if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end
	return 0`;

export class FailureAuditService {
	constructor(
		private readonly database: Pick<Database, "transaction">,
		private readonly redis: Pick<Redis, "send">,
		private readonly audit: Pick<AuditService, "recordOnce">,
		private readonly events: Pick<EventService, "emit">,
		private readonly settings: Pick<SettingsService, "read">,
	) {}
	async record(
		code: $ValidationCode,
		licenseId: string | undefined,
		context: $RequestContext,
		groupId: string | null = null,
	) {
		const settings = await this.settings.read(undefined, context.deadlineAt);
		// Unrecognised credentials share a source/class bucket. Never use submitted
		// credentials, hardware text or expected group claims as keys or evidence.
		const fingerprint = new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify([code, licenseId ?? null, context.clientIp, groupId]),
			)
			.digest("hex");
		const base = `kz:failure:v2:{${fingerprint}}`;
		const keys = [base, `${base}:claim`, `${base}:cooldown`];
		const token = Bun.randomUUIDv7();
		const evidence = await this.redis
			.send(
				"EVAL",
				[
					acquire,
					"3",
					...keys,
					String(settings.failureWindowSeconds),
					String(settings.failureThreshold),
					Bun.randomUUIDv7(),
					token,
					String(leaseSeconds),
					String(settings.failureCooldownSeconds),
				],
				context.deadlineAt,
			)
			.catch(() => {
				throw new HttpError("SERVICE_UNAVAILABLE");
			});
		if (evidence === 0) return;
		if (
			typeof evidence !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
				evidence,
			)
		)
			throw new HttpError("SERVICE_UNAVAILABLE");
		try {
			await this.database.transaction(
				async (tx) => {
					const inserted = await this.audit.recordOnce(
						tx,
						{
							requestId: context.requestId,
							clientIp: context.clientIp,
							actor: {
								kind: licenseId ? "license" : "anonymous",
								id: licenseId ?? null,
								name: licenseId ? "License" : null,
							},
							action: "validation.failed",
							targetType: "license",
							targetId: licenseId,
							groupId,
							after: { code },
						},
						evidence,
					);
					if (inserted)
						await this.events.emit(tx, "validation.failed", {
							licenseId,
							groupId,
							code,
						});
				},
				"read",
				context.deadlineAt,
			);
			const completed = await this.redis.send(
				"EVAL",
				[
					acknowledge,
					"3",
					...keys,
					token,
					evidence,
					String(settings.failureCooldownSeconds),
				],
				context.deadlineAt,
			);
			if (completed !== 1) throw new Error("Failure audit claim expired");
		} catch {
			// Best effort within THIS request's deadline. Lease expiry is the safe
			// fallback, and does not consume either the count or the cooldown.
			await this.redis
				.send(
					"EVAL",
					[release, "1", `${base}:claim`, token],
					context.deadlineAt,
				)
				.catch(() => undefined);
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
	}
}
