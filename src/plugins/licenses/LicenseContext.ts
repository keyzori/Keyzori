import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import type { AuthService } from "../../core/auth/AuthService";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";

/** Shared licence authority and lock ordering inside the caller's transaction. */
export class LicenseContext {
	constructor(private readonly auth: AuthService) {}

	async lock(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(licenses)
			.where(inArray(licenses.id, ids))
			.orderBy(asc(licenses.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}

	async authorizeLocked(
		tx: $Transaction,
		operation: $Operation,
		scope: string,
		ids: string[],
	) {
		// Lock/recheck credentials before resources, retaining both until COMMIT.
		const principal = await this.auth.authorize(tx, operation.principal, scope);
		const rows = ids.length ? await this.lock(tx, ids) : [];
		for (const row of rows) this.auth.requireGroup(principal, row.groupId);
		return { principal, rows };
	}

	async authorize(
		tx: $Transaction,
		operation: $Operation,
		scope: string,
		ids: string[] = [],
		groupId?: string | null,
		userId?: string | null,
	) {
		const { principal } = await this.authorizeLocked(tx, operation, scope, ids);
		if (groupId !== undefined) this.auth.requireGroup(principal, groupId);
		if (userId) {
			this.auth.require(principal, "users:read");
			if (principal.kind !== "root" && !principal.allGroups) {
				const [visible] = await tx
					.select({ id: licenses.id })
					.from(licenses)
					.where(
						and(
							eq(licenses.userId, userId),
							this.auth.groupFilter(principal, licenses.groupId),
						),
					)
					.limit(1);
				if (!visible) throw new HttpError("FORBIDDEN");
			}
		}
		return principal;
	}

	/** Read after acquiring licence locks so queued work uses the current period. */
	async now(tx: $Transaction) {
		const [row] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!row) throw new Error("Database time unavailable");
		return row.now;
	}

	evidence(operation: $Operation, licenseId: string, reason?: string) {
		return {
			...operation,
			actor: operation.principal,
			action: "license.updated",
			targetType: "license",
			targetId: licenseId,
			reason,
		};
	}
}
