import { asc, eq, inArray } from "drizzle-orm";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import { items } from "../../core/database/schema/items";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";
import type {
	$Item,
	$ItemCreate,
	$ItemUpdate,
	$ItemEnable,
	$ItemDisable,
	$ItemRemove,
} from "../../types/items";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { LicenseDeletion } from "../licenses/LicenseDeletion";
import type { KeyGenerator } from "../../core/security/KeyGenerator";
import type { $KeyFormat } from "../../types/security";

export class ItemService {
	private readonly policy = new InputPolicy();

	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly settings: SettingsService,
		private readonly idem: IdempotencyService,
		private readonly deletion: LicenseDeletion,
		private readonly keys: KeyGenerator,
	) {}

	async create(input: $ItemCreate, operation: $Operation) {
		this.auth.require(operation.principal, "items:create");
		this.policy.metadata(input.metadata);
		this.policy.notes(input.notes);
		return this.idem.admin(
			operation,
			"item.create",
			input,
			async (tx, now) => {
				await this.keyFormat(tx, input.keyFormat);
				const [row] = await tx
					.insert(items)
					.values({
						id: Bun.randomUUIDv7(),
						name: input.name,
						metadata: input.metadata ?? {},
						notes: input.notes ?? null,
						keyFormat: input.keyFormat ?? null,
						createdBy: operation.principal.id,
						updatedBy: operation.principal.id,
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				if (!row) throw new Error("Item creation returned no record");
				await this.audit.record(tx, {
					...operation,
					actor: operation.principal,
					action: "item.created",
					targetType: "item",
					targetId: row.id,
					after: this.admin(row),
				});
				await this.events.emit(tx, "item.created", { itemId: row.id }, now);
				return { data: this.admin(row) };
			},
			{ topology: "write" },
		);
	}

	async read(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "items:read");
		const principal = operation.principal;
		if (
			principal.kind === "license" &&
			(params.size !== 1 ||
				params.get("id") !== principal.itemId ||
				!principal.itemId)
		) {
			throw new HttpError("FORBIDDEN");
		}
		return this.database.transaction(
			async (tx) => {
				const license = await this.auth.assertLicense(tx, principal);
				if (license && params.get("id") !== license.itemId)
					throw new HttpError("FORBIDDEN");
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					params,
					items,
					settings.defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(items)
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

	async update(input: $ItemUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "items:update");
		const ids = this.policy.ids(input.ids);
		this.policy.metadata(input.changes.metadata);
		this.policy.notes(input.changes.notes);
		return this.idem.admin(
			operation,
			"item.update",
			input,
			async (tx, now) => {
				await this.keyFormat(tx, input.changes.keyFormat);
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
						keyFormat:
							input.changes.keyFormat === undefined
								? row.keyFormat
								: input.changes.keyFormat,
					};
					const diff = this.audit.changes(
						{
							name: row.name,
							metadata: row.metadata,
							notes: row.notes,
							keyFormat: row.keyFormat,
						},
						after,
					);
					if (!diff.changed) {
						data.push(this.admin(row));
						continue;
					}
					const [updated] = await tx
						.update(items)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(items.id, row.id))
						.returning();
					if (!updated) throw new Error("Item update returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "item.updated",
						targetType: "item",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, "item.updated", { itemId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	enable(input: $ItemEnable, operation: $Operation) {
		this.auth.require(operation.principal, "items:enable");
		return this.setEnabled(input, operation, true);
	}

	disable(input: $ItemDisable, operation: $Operation) {
		this.auth.require(operation.principal, "items:disable");
		return this.setEnabled(input, operation, false, input.disabledReason);
	}

	async remove(input: $ItemRemove, operation: $Operation) {
		this.auth.require(operation.principal, "items:delete");
		this.auth.require(operation.principal, "licenses:delete");
		const ids = this.policy.ids(input.ids);
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		return this.idem.admin(
			operation,
			"item.delete",
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const children = await tx
					.select({ id: licenses.id })
					.from(licenses)
					.where(inArray(licenses.itemId, ids))
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
						action: "item.deleted",
						targetType: "item",
						targetId: row.id,
						reason: input.reason,
						before: this.admin(row),
					});
					await this.events.emit(tx, "item.deleted", { itemId: row.id }, now);
					await tx.delete(items).where(eq(items.id, row.id));
				}
				return { data: { ids } };
			},
			{ topology: "write" },
		);
	}

	private async targets(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(items)
			.where(inArray(items.id, ids))
			.orderBy(asc(items.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}

	private setEnabled(
		input: $ItemEnable,
		operation: $Operation,
		enabled: boolean,
		reason?: string,
	) {
		const ids = this.policy.ids(input.ids);
		const action = enabled ? "item.enabled" : "item.disabled";
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
						.update(items)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(items.id, row.id))
						.returning();
					if (!updated) throw new Error("Item state change returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action,
						targetType: "item",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, action, { itemId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	private public(row: $Item) {
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			metadata: row.metadata,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}

	private admin(row: $Item) {
		return {
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			metadata: row.metadata,
			notes: row.notes,
			disabledReason: row.disabledReason,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			keyFormat: row.keyFormat,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}

	private async keyFormat(tx: $Transaction, format?: $KeyFormat | null) {
		if (format === undefined) return;
		if ((await this.settings.read(tx)).globalFormatEnabled) {
			throw new HttpError("CONFLICT", {
				keyFormat:
					"Item key formats cannot be changed while global format mode is enabled",
			});
		}
		if (format === null) return;
		try {
			this.keys.validate(format);
		} catch {
			throw new HttpError("INVALID_REQUEST", {
				keyFormat: "Invalid key format or insufficient entropy",
			});
		}
	}
}
