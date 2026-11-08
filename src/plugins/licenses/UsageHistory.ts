import { and, eq } from "drizzle-orm";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import type { Database } from "../../core/database/Database";
import type { AuthService } from "../../core/auth/AuthService";
import type { $Operation } from "../../types/operation";

/** Historical acceptance never asserts that a licence is currently eligible. */
export class UsageHistory {
	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
	) {}
	read(id: string, operation: $Operation) {
		new InputPolicy().ids([id]);
		return this.query(operation, { id });
	}
	lookup(licenseId: string, operation: $Operation) {
		new InputPolicy().ids([licenseId]);
		const key = new InputPolicy().idempotency(operation.idempotencyKey, true);
		if (!key) throw new HttpError("INVALID_REQUEST");
		return this.query(operation, { licenseId, key });
	}
	private query(
		operation: $Operation,
		selector: { id: string } | { licenseId: string; key: string },
	) {
		this.auth.require(operation.principal, "usage:read");
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"usage:read",
				);
				const [receipt] = await tx
					.select()
					.from(usageOperations)
					.where(
						and(
							"id" in selector
								? eq(usageOperations.id, selector.id)
								: and(
										eq(usageOperations.licenseId, selector.licenseId),
										eq(usageOperations.principalId, principal.id),
										eq(usageOperations.idempotencyKey, selector.key),
									),
							this.auth.groupFilter(principal, usageOperations.groupId),
						),
					)
					.limit(1);
				if (!receipt) throw new HttpError("NOT_FOUND");
				return {
					data: {
						id: receipt.id,
						licenseId: receipt.licenseId,
						consumedAt: receipt.createdAt.toISOString(),
						historical: true as const,
						outcome: "accepted" as const,
						entries: receipt.entries,
					},
				};
			},
			"none",
			operation.deadlineAt,
		);
	}
}
