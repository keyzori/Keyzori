import { asc, eq, inArray } from "drizzle-orm";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import { users } from "../../core/database/schema/users";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";
import type {
	$User,
	$UserCreate,
	$UserUpdate,
	$UserEnable,
	$UserDisable,
	$UserRemove,
} from "../../types/users";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { LicenseDeletion } from "../licenses/LicenseDeletion";

export class UserService {
	private readonly policy = new InputPolicy();

	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly settings: SettingsService,
		private readonly idem: IdempotencyService,
		private readonly deletion: LicenseDeletion,
	) {}

	async create(input: $UserCreate, operation: $Operation) {
		this.auth.require(operation.principal, "users:create");
		this.policy.metadata(input.metadata);
		this.policy.notes(input.notes);
		return this.idem.admin(
			operation,
			"user.create",
			input,
			async (tx, now) => {
				const [row] = await tx
					.insert(users)
					.values({
						id: Bun.randomUUIDv7(),
						name: input.name,
						metadata: input.metadata ?? {},
						notes: input.notes ?? null,
						createdBy: operation.principal.id,
						updatedBy: operation.principal.id,
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				if (!row) throw new Error("User creation returned no record");
				await this.audit.record(tx, {
					...operation,
					actor: operation.principal,
					action: "user.created",
					targetType: "user",
					targetId: row.id,
					after: this.admin(row),
				});
				await this.events.emit(tx, "user.created", { userId: row.id }, now);
				return { data: this.admin(row) };
			},
			{ topology: "write" },
		);
	}

	async read(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "users:read");
		const principal = operation.principal;
		if (
			principal.kind === "license" &&
			(params.size !== 1 ||
				params.get("id")?.toLowerCase() !== principal.userId ||
				!principal.userId)
		) {
			throw new HttpError("FORBIDDEN");
		}
		return this.database.transaction(
			async (tx) => {
				const license = await this.auth.assertLicense(tx, principal);
				if (license && params.get("id")?.toLowerCase() !== license.userId)
					throw new HttpError("FORBIDDEN");
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					params,
					users,
					settings.defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(users)
					.where(query.where)
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id) {
					const row = rows[0];
					if (!row) throw new HttpError("NOT_FOUND");
					return {
						data:
							principal.kind === "license" ? this.public(row) : this.admin(row),
					};
				}
				const selected = rows.slice(0, query.limit);
				const last = selected.at(-1);
				return {
					data: selected.map((row) => this.admin(row)),
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async update(input: $UserUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "users:update");
		const ids = this.policy.ids(input.ids);
		this.policy.metadata(input.changes.metadata);
		this.policy.notes(input.changes.notes);
		return this.idem.admin(
			operation,
			"user.update",
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const data = [];
				for (const row of rows) {
					const after = {
						name: input.changes.name ?? row.name,
						metadata: input.changes.metadata ?? row.metadata,
						notes:
							input.changes.notes === undefined
								? row.notes
								: input.changes.notes,
					};
					const diff = this.audit.changes(
						{
							name: row.name,
							metadata: row.metadata,
							notes: row.notes,
						},
						after,
					);
					if (!diff.changed) {
						data.push(this.admin(row));
						continue;
					}
					const [updated] = await tx
						.update(users)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(users.id, row.id))
						.returning();
					if (!updated) throw new Error("User update returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "user.updated",
						targetType: "user",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, "user.updated", { userId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	enable(input: $UserEnable, operation: $Operation) {
		this.auth.require(operation.principal, "users:enable");
		return this.setEnabled(input, operation, true);
	}

	disable(input: $UserDisable, operation: $Operation) {
		this.auth.require(operation.principal, "users:disable");
		return this.setEnabled(input, operation, false, input.disabledReason);
	}

	async remove(input: $UserRemove, operation: $Operation) {
		this.auth.require(operation.principal, "users:delete");
		this.auth.require(operation.principal, "licenses:delete");
		const ids = this.policy.ids(input.ids);
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		return this.idem.admin(
			operation,
			"user.delete",
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const children = await tx
					.select({ id: licenses.id })
					.from(licenses)
					.where(inArray(licenses.userId, ids))
					.orderBy(asc(licenses.id));
				await this.deletion.remove(
					tx,
					children.map((row) => row.id),
					operation,
					input.reason,
				);
				for (const row of rows) {
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "user.deleted",
						targetType: "user",
						targetId: row.id,
						reason: input.reason,
						before: this.admin(row),
					});
					await this.events.emit(tx, "user.deleted", { userId: row.id }, now);
					await tx.delete(users).where(eq(users.id, row.id));
				}
				return { data: { ids } };
			},
			{ topology: "write" },
		);
	}

	private async targets(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(users)
			.where(inArray(users.id, ids))
			.orderBy(asc(users.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}

	private setEnabled(
		input: $UserEnable,
		operation: $Operation,
		enabled: boolean,
		reason?: string,
	) {
		const ids = this.policy.ids(input.ids);
		const action = enabled ? "user.enabled" : "user.disabled";
		return this.idem.admin(
			operation,
			action,
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const data = [];
				for (const row of rows) {
					const after = {
						enabled,
						disabledReason: enabled ? null : (reason ?? null),
					};
					const diff = this.audit.changes(
						{ enabled: row.enabled, disabledReason: row.disabledReason },
						after,
					);
					if (!diff.changed) {
						data.push(this.admin(row));
						continue;
					}
					const [updated] = await tx
						.update(users)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(users.id, row.id))
						.returning();
					if (!updated) throw new Error("User state change returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action,
						targetType: "user",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, action, { userId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	private public(row: $User) {
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			metadata: row.metadata,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}

	private admin(row: $User) {
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			metadata: row.metadata,
			notes: row.notes,
			disabledReason: row.disabledReason,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}
