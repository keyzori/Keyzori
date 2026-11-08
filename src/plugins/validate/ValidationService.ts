import { eq, sql } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { SecretHasher } from "../../core/security/SecretHasher";
import { InputPolicy } from "../../core/http/InputPolicy";
import { HttpError } from "../../core/http/HttpError";
import { Decision } from "./Decision";
import { Eligibility } from "./Eligibility";
import { LicenseView } from "../licenses/LicenseView";
import type { Database } from "../../core/database/Database";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { Redis } from "../../core/redis/Redis";
import type { SettingsService } from "../settings/SettingsService";
import type { FailureAuditService } from "../audits/FailureAuditService";
import type { MeterService } from "../licenses/MeterService";
import type { $ValidationInput } from "../../types/validation";
import type { $RequestContext } from "../../types/http";

export class ValidationService {
	private readonly hasher = new SecretHasher();
	private readonly eligibility;
	private readonly view;
	constructor(
		private readonly database: Database,
		private readonly redis: Redis,
		settings: SettingsService,
		ip: ClientIpResolver,
		metering: MeterService,
		private readonly failures: FailureAuditService,
	) {
		this.eligibility = new Eligibility(settings, ip);
		this.view = new LicenseView(metering);
	}
	async validate(input: $ValidationInput, context: $RequestContext) {
		new InputPolicy().jsonText(input);
		try {
			if (!(await this.redis.ping(context.deadlineAt)))
				throw new Error("Redis unavailable");
		} catch {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
		const result = await this.database.transaction(
			async (tx) => {
				const [license] = await tx
					.select()
					.from(licenses)
					.where(eq(licenses.keyHash, this.hasher.hash(input.license)))
					.for("share");
				const [clock] = await tx
					.select({ now: sql<Date>`clock_timestamp()` })
					.from(sql`(values (1)) as clock`);
				if (!clock) throw new Error("Database time unavailable");
				const decision = license
					? await this.eligibility.check(
							tx,
							license,
							input,
							context.clientIp,
							clock.now,
						)
					: new Decision("LICENSE_INVALID");
				return {
					data: {
						valid: decision.code === "VALID",
						...decision.response(),
						evaluatedAt: clock.now.toISOString(),
						license: license
							? await this.view.validation(tx, license, clock.now)
							: null,
					},
				};
			},
			"read",
			context.deadlineAt,
		);
		if (!result.data.valid)
			await this.failures.record(
				result.data.code,
				result.data.license?.id,
				input.license,
				context,
				input.hardwareId,
				result.data.license?.groupId ?? null,
			);
		return result;
	}
}
