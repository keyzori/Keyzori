import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import type { AuthService } from "../../core/auth/AuthService";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type { $Principal } from "../../types/auth";

/** Shared licence authority and lock ordering inside the caller's transaction. */
export class LicenseContext {
	constructor(private readonly auth: AuthService) {}

	/** One sorted, SQL-scoped lock set per transaction, shared by authorization, receipt and mutation. */
	targets<T extends Record<string, PgColumn>>(
		operation: $Operation,
		scope: string,
		ids: string[],
		fields: T,
		groupId?: string | null,
		userId?: string | null,
	) {
		const wanted = new Set(ids.map((id) => id.toLowerCase()));
		const load = async (tx: $Transaction) => {
			const principal = await this.auth.authorize(
				tx,
				operation.principal,
				scope,
			);
			const visible = this.auth.groupFilter(principal, licenses.groupId);
			if (groupId !== undefined) this.auth.requireGroup(principal, groupId);
			let witness: string | undefined;
			if (userId) {
				this.auth.require(principal, "users:read");
				if (principal.kind === "api" && !principal.allGroups) {
					const [link] = await tx
						.select({ id: licenses.id })
						.from(licenses)
						.where(and(eq(licenses.userId, userId), visible))
						.orderBy(asc(licenses.id))
						.limit(1);
					if (!link) throw new HttpError("FORBIDDEN");
					witness = link.id;
				}
			}
			// The witness can be a target itself. Acquire both in UUID order and
			// recheck its association after waiting, before relying on it.
			const lockIds = witness
				? [...new Set([...wanted, witness])]
				: [...wanted];
			const locked = lockIds.length
				? await tx
						.select({
							resourceId: licenses.id,
							assignedUser: licenses.userId,
							selected: fields,
						})
						.from(licenses)
						.where(and(inArray(licenses.id, lockIds), visible))
						.orderBy(asc(licenses.id))
						.for("update")
				: [];
			if (
				witness &&
				!locked.some(
					(row) =>
						row.resourceId === witness &&
						row.assignedUser === userId?.toLowerCase(),
				)
			)
				throw new HttpError("FORBIDDEN");
			const rows = locked
				.filter((row) => wanted.has(row.resourceId))
				.map((row) => row.selected);
			if (rows.length !== wanted.size)
				throw new HttpError(
					wanted.size === 1 ? "NOT_FOUND" : "BULK_OPERATION_FAILED",
				);
			return { principal, rows };
		};
		const loaded = new WeakMap<
			$Transaction,
			Awaited<ReturnType<typeof load>>
		>();
		return {
			authorize: async (tx: $Transaction) => {
				const state = await load(tx);
				loaded.set(tx, state);
				return state.principal;
			},
			state: (tx: $Transaction) => {
				const state = loaded.get(tx);
				if (!state)
					throw new Error(
						"Licence targets were not authorized in this transaction",
					);
				return state;
			},
		};
	}

	/** Read after acquiring licence locks so queued work uses the current period. */
	async now(tx: $Transaction, principal?: $Principal) {
		const [row] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!row) throw new Error("Database time unavailable");
		if (principal) this.auth.requireUnexpired(principal, row.now);
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
