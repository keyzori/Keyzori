import { and, eq } from "drizzle-orm";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { AuditService } from "../audits/AuditService";
import type { Eligibility } from "../validate/Eligibility";
import type { EventService } from "../webhooks/EventService";
import type { LicenseContext } from "./LicenseContext";
import type { MeterService } from "./MeterService";
import type { $MeterAdjustment, $UsageConsume } from "../../types/licenses";
import type { $Operation } from "../../types/operation";

/** Atomic counter mutations and accepted-operation receipts. */
export class LicenseUsage {
	private readonly input = new InputPolicy();
	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly idempotency: IdempotencyService,
		private readonly meters: MeterService,
		private readonly eligibility: Eligibility,
		private readonly context: LicenseContext,
	) {}

	async consume(input: $UsageConsume, operation: $Operation) {
		this.auth.require(operation.principal, "usage:consume");
		this.input.jsonText(input);
		const key = this.input.idempotency(operation.idempotencyKey, true);
		if (!key) throw new HttpError("INVALID_REQUEST");
		const fingerprint = this.idempotency.fingerprint(input);
		return this.database.idempotentTransaction(
			async (tx) => {
				const { principal, rows } = await this.context.authorizeLocked(
					tx,
					operation,
					"usage:consume",
					[input.licenseId],
				);
				const license = rows[0];
				if (!license) throw new HttpError("NOT_FOUND");
				const now = await this.context.now(tx);
				const decision = await this.eligibility.check(
					tx,
					license,
					input,
					operation.clientIp,
					now,
				);
				if (decision.code !== "VALID")
					throw new HttpError("CONFLICT", {
						license: decision.code,
						reason: decision.message,
					});
				const [existing] = await tx
					.select()
					.from(usageOperations)
					.where(
						and(
							eq(usageOperations.licenseId, license.id),
							eq(usageOperations.principalId, principal.id),
							eq(usageOperations.idempotencyKey, key),
						),
					);
				if (existing) {
					this.auth.requireGroup(principal, existing.groupId);
					if (existing.fingerprint !== fingerprint)
						throw new HttpError("IDEMPOTENCY_KEY_REUSED");
					return {
						data: {
							id: existing.id,
							licenseId: existing.licenseId,
							consumedAt: existing.createdAt.toISOString(),
							replayed: true,
							entries: existing.entries,
						},
					};
				}
				const evidence = this.context.evidence(operation, license.id);
				const counters = await this.meters.effective(
					tx,
					license.id,
					evidence,
					now,
				);
				const entries = await this.meters.consume(
					tx,
					counters,
					input.usage,
					evidence,
					now,
				);
				const id = Bun.randomUUIDv7();
				await tx.insert(usageOperations).values({
					id,
					licenseId: license.id,
					groupId: license.groupId,
					principalId: principal.id,
					idempotencyKey: key,
					fingerprint,
					requestId: operation.requestId,
					entries,
					createdAt: now,
				});
				await this.audit.record(tx, {
					...evidence,
					action: "usage.consumed",
					after: { operationId: id, entries },
				});
				await this.events.emit(
					tx,
					"usage.consumed",
					{ licenseId: license.id, groupId: license.groupId, operationId: id },
					now,
				);
				return {
					data: {
						id,
						licenseId: license.id,
						consumedAt: now.toISOString(),
						replayed: false,
						entries,
					},
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async adjust(input: $MeterAdjustment, operation: $Operation) {
		this.auth.require(operation.principal, "usage:adjust");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"license.meter.adjust",
			input,
			async (tx) => {
				const locked = await this.context.lock(tx, ids);
				const now = await this.context.now(tx);
				for (const row of locked)
					await this.meters.adjust(
						tx,
						row.id,
						input.name,
						input.action,
						input.value,
						this.context.evidence(operation, row.id, input.reason),
						now,
					);
				return { data: { ids } };
			},
			{
				authorize: (tx) =>
					this.context.authorize(tx, operation, "usage:adjust", ids),
			},
		);
	}
}
