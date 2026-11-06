import { and, asc, eq, inArray } from "drizzle-orm";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import { groups } from "../../core/database/schema/groups";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";
import type {
	$Group,
	$GroupCreate,
	$GroupUpdate,
	$GroupEnable,
	$GroupDisable,
	$GroupRemove,
} from "../../types/groups";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { SettingsService } from "../settings/SettingsService";
import type { KeyGenerator } from "../../core/security/KeyGenerator";
import type { $KeyFormat } from "../../types/security";

export class GroupService {
	private readonly policy = new InputPolicy();

	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly events: EventService,
		private readonly settings: SettingsService,
		private readonly idem: IdempotencyService,
		private readonly keys: KeyGenerator,
	) {}

	async create(input: $GroupCreate, operation: $Operation) {
		this.auth.require(operation.principal, "groups:create");
		this.policy.metadata(input.metadata);
		this.policy.notes(input.notes);
		return this.idem.admin(
			operation,
			"group.create",
			input,
			async (tx, now) => {
				await this.keyFormat(tx, input.keyFormat);
				const [row] = await tx
					.insert(groups)
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
				if (!row) throw new Error("Group creation returned no record");
				await this.audit.record(tx, {
					...operation,
					actor: operation.principal,
					action: "group.created",
					targetType: "group",
					targetId: row.id,
					after: this.admin(row),
				});
				await this.events.emit(tx, "group.created", { groupId: row.id }, now);
				return { data: this.admin(row) };
			},
			{
				topology: "write",
				authorize: (tx) => this.authorize(tx, operation, "groups:create"),
			},
		);
	}

	async read(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "groups:read");
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"groups:read",
				);
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					params,
					groups,
					settings.defaultPageLimit,
				);
				const visibility = this.auth.groupFilter(principal, groups.id);
				const rows = await tx
					.select()
					.from(groups)
					.where(and(query.where, visibility))
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id) {
					const row = rows[0];
					if (!row) throw new HttpError("NOT_FOUND");
					return { data: this.admin(row) };
				}
				const selected = rows.slice(0, query.limit);
				const last = selected.at(-1);
				return {
					data: selected.map((row) => this.admin(row)),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async update(input: $GroupUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "groups:update");
		const ids = this.policy.ids(input.ids);
		this.policy.metadata(input.changes.metadata);
		this.policy.notes(input.changes.notes);
		return this.idem.admin(
			operation,
			"group.update",
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
						.update(groups)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(groups.id, row.id))
						.returning();
					if (!updated) throw new Error("Group update returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "group.updated",
						targetType: "group",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, "group.updated", { groupId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{
				topology: "write",
				authorize: (tx) => this.authorize(tx, operation, "groups:update", ids),
			},
		);
	}

	enable(input: $GroupEnable, operation: $Operation) {
		this.auth.require(operation.principal, "groups:enable");
		return this.setEnabled(input, operation, true);
	}

	disable(input: $GroupDisable, operation: $Operation) {
		this.auth.require(operation.principal, "groups:disable");
		return this.setEnabled(input, operation, false, input.disabledReason);
	}

	async remove(input: $GroupRemove, operation: $Operation) {
		this.auth.require(operation.principal, "groups:delete");
		this.auth.require(operation.principal, "licenses:disable");
		const ids = this.policy.ids(input.ids);
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		return this.idem.admin(
			operation,
			"group.delete",
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const children = await tx
					.select()
					.from(licenses)
					.where(inArray(licenses.groupId, ids))
					.orderBy(asc(licenses.id))
					.limit(1001)
					.for("update");
				if (children.length > 1000)
					throw new HttpError("CONFLICT", {
						groups:
							"Use the audited disable-and-detach operation before deleting a group with more than 1000 associated licences",
					});
				for (const child of children) {
					const disabledReason =
						child.disabledReason ?? "Associated group was deleted";
					await tx
						.update(licenses)
						.set({
							enabled: false,
							disabledReason,
							groupId: null,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(licenses.id, child.id));
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "license.group_deleted",
						targetType: "license",
						targetId: child.id,
						groupId: child.groupId,
						reason: input.reason,
						before: { groupId: child.groupId, enabled: child.enabled },
						after: { groupId: null, enabled: false, disabledReason },
					});
					await this.events.emit(
						tx,
						"license.disabled",
						{ licenseId: child.id, groupId: child.groupId },
						now,
					);
				}
				for (const row of rows) {
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "group.deleted",
						targetType: "group",
						targetId: row.id,
						reason: input.reason,
						before: this.admin(row),
					});
					await this.events.emit(tx, "group.deleted", { groupId: row.id }, now);
					await tx.delete(groups).where(eq(groups.id, row.id));
				}
				return { data: { ids } };
			},
			{
				topology: "write",
				scope: "groups:delete",
				authority: async () => ({
					groupIds: ids,
					scopes: ["licenses:disable"],
				}),
				authorize: (tx) => this.authorize(tx, operation, "groups:delete", ids),
			},
		);
	}

	/** Bounded preparation for large deletions: no key is detached while enabled. */
	async detachLicenses(
		input: { groupId: string; ids: string[]; reason: string },
		operation: $Operation,
	) {
		const ids = this.policy.ids(input.ids);
		this.policy.ids([input.groupId]);
		this.policy.text(input.reason);
		this.policy.idempotency(operation.idempotencyKey, true);
		if (!input.reason) throw new HttpError("INVALID_REQUEST");
		this.auth.require(operation.principal, "groups:delete");
		this.auth.require(operation.principal, "licenses:disable");
		return this.idem.admin(
			operation,
			"group.detach-licenses",
			input,
			async (tx, now) => {
				const children = await tx
					.select()
					.from(licenses)
					.where(inArray(licenses.id, ids))
					.orderBy(asc(licenses.id))
					.for("update");
				if (
					children.length !== ids.length ||
					children.some((row) => row.groupId !== input.groupId)
				)
					throw new HttpError("BULK_OPERATION_FAILED");
				for (const child of children) {
					const disabledReason =
						child.disabledReason ?? "Detached while preparing group deletion";
					await tx
						.update(licenses)
						.set({
							enabled: false,
							groupId: null,
							disabledReason,
							updatedAt: now,
							updatedBy: operation.principal.id,
						})
						.where(eq(licenses.id, child.id));
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "license.group_detached",
						targetType: "license",
						targetId: child.id,
						groupId: input.groupId,
						reason: input.reason,
						before: { groupId: input.groupId, enabled: child.enabled },
						after: { groupId: null, enabled: false, disabledReason },
					});
					await this.events.emit(
						tx,
						"license.group_detached",
						{ licenseId: child.id, groupId: input.groupId },
						now,
					);
					await this.events.emit(
						tx,
						"license.disabled",
						{ licenseId: child.id, groupId: input.groupId },
						now,
					);
				}
				return { data: { ids } };
			},
			{
				topology: "write",
				scope: "groups:delete",
				authority: async () => ({
					groupIds: [input.groupId],
					scopes: ["licenses:disable"],
				}),
				authorize: (tx) =>
					this.authorize(tx, operation, "groups:delete", [input.groupId]),
			},
		);
	}

	private async targets(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(groups)
			.where(inArray(groups.id, ids))
			.orderBy(asc(groups.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}

	private setEnabled(
		input: $GroupEnable,
		operation: $Operation,
		enabled: boolean,
		reason?: string,
	) {
		const ids = this.policy.ids(input.ids);
		const action = enabled ? "group.enabled" : "group.disabled";
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
						.update(groups)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(groups.id, row.id))
						.returning();
					if (!updated)
						throw new Error("Group state change returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action,
						targetType: "group",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					await this.events.emit(tx, action, { groupId: row.id }, now);
					data.push(this.admin(updated));
				}
				return { data };
			},
			{
				topology: "write",
				authorize: (tx) =>
					this.authorize(
						tx,
						operation,
						`groups:${enabled ? "enable" : "disable"}`,
						ids,
					),
			},
		);
	}

	private admin(row: $Group) {
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
					"Group key formats cannot be changed while global format mode is enabled",
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
	private async authorize(
		tx: $Transaction,
		operation: $Operation,
		scope: string,
		ids?: string[],
	) {
		const principal = await this.auth.authorize(tx, operation.principal, scope);
		if (ids) {
			for (const row of await this.targets(tx, ids))
				this.auth.requireGroup(principal, row.id);
		} else this.auth.requireAllGroups(principal);
		if (scope === "groups:delete")
			this.auth.require(principal, "licenses:disable");
		return principal;
	}
}
