import { asc, eq, inArray } from "drizzle-orm";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { apiKeyGroups } from "../../core/database/schema/apiKeyGroups";
import { groups } from "../../core/database/schema/groups";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { SecretHasher } from "../../core/security/SecretHasher";
import { ScopeService } from "../../core/auth/ScopeService";
import { InputPolicy } from "../../core/http/InputPolicy";
import { HttpError } from "../../core/http/HttpError";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { Database } from "../../core/database/Database";
import type { AuditService } from "../audits/AuditService";
import type { SettingsService } from "../settings/SettingsService";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type {
	$ApiKey,
	$ApiKeyCreate,
	$ApiKeyUpdate,
	$ApiKeyAction,
	$ApiKeyDelete,
} from "../../types/apiKeys";
import type { $Operation } from "../../types/operation";
import type { $Transaction } from "../../types/database";

export class ApiKeyService {
	private readonly keys = new KeyGenerator();
	private readonly hashes = new SecretHasher();
	private readonly scopes = new ScopeService();
	private readonly input = new InputPolicy();
	constructor(
		private readonly database: Database,
		private readonly audit: AuditService,
		private readonly settings: SettingsService,
		private readonly idempotency: IdempotencyService,
	) {}
	async create(input: $ApiKeyCreate, operation: $Operation) {
		this.root(operation);
		return this.idempotency.admin(
			operation,
			"api-key.create",
			input,
			async (tx) => {
				const id = Bun.randomUUIDv7();
				const generated = this.keys.api(id);
				const [row] = await tx
					.insert(apiKeys)
					.values({
						id,
						name: input.name,
						description: input.description ?? null,
						scopes: [],
						allGroups: false,
						secretHash: this.hashes.hash(generated.secret),
						expiresAt: input.expiresAt
							? this.input.timestamp(input.expiresAt)
							: null,
						createdBy: "root",
						updatedBy: "root",
					})
					.returning();
				if (!row) throw new Error("API key creation failed");
				const data = this.view(row, []);
				await this.audit.record(tx, {
					...operation,
					actor: operation.principal,
					action: "api-key.created",
					targetType: "api-key",
					targetId: id,
					after: data,
				});
				return { data, credential: generated.credential };
			},
			{ secretIds: (result) => [result.data.id] },
		);
	}
	async read(params: URLSearchParams, operation: $Operation) {
		this.root(operation);
		return this.database.transaction(
			async (tx) => {
				const query = new ResourceQuery(
					params,
					apiKeys,
					(await this.settings.read(tx)).defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(apiKeys)
					.where(query.where)
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				const grants = await this.grants(
					tx,
					rows.map((row) => row.id),
				);
				if (query.id) {
					if (!rows[0]) throw new HttpError("NOT_FOUND");
					return { data: this.view(rows[0], grants.get(rows[0].id) ?? []) };
				}
				const page = rows.slice(0, query.limit);
				const last = page.at(-1);
				return {
					data: page.map((row) => this.view(row, grants.get(row.id) ?? [])),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}
	async update(input: $ApiKeyUpdate, operation: $Operation) {
		this.root(operation);
		const scopes =
			input.changes.scopes === undefined
				? undefined
				: this.validateScopes(input.changes.scopes);
		const selectedGroups =
			input.changes.groupIds === undefined
				? undefined
				: this.groupIds(input.changes.groupIds);
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"api-key.update",
			input,
			async (tx, now) => {
				const rows = await this.lock(tx, ids);
				const grants = await this.grants(tx, ids);
				if (selectedGroups?.length) {
					const existing = await tx
						.select({ id: groups.id })
						.from(groups)
						.where(inArray(groups.id, selectedGroups))
						.orderBy(asc(groups.id))
						.for("key share");
					if (existing.length !== selectedGroups.length)
						throw new HttpError("INVALID_REQUEST", {
							groupIds: "Unknown group",
						});
				}
				for (const row of rows) {
					const beforeGroups = grants.get(row.id) ?? [];
					const groupIds = selectedGroups ?? beforeGroups;
					const allGroups = input.changes.allGroups ?? row.allGroups;
					if (allGroups && groupIds.length)
						throw new HttpError("INVALID_REQUEST", {
							groupIds: "All-group access requires an empty groupIds list",
						});
					const changes = {
						name: input.changes.name ?? row.name,
						description:
							input.changes.description === undefined
								? row.description
								: input.changes.description,
						scopes: scopes ?? row.scopes,
						allGroups,
						expiresAt:
							input.changes.expiresAt === undefined
								? row.expiresAt
								: input.changes.expiresAt
									? this.input.timestamp(input.changes.expiresAt)
									: null,
					};
					const diff = this.audit.changes(
						{
							name: row.name,
							description: row.description,
							scopes: row.scopes,
							allGroups: row.allGroups,
							groupIds: beforeGroups,
							expiresAt: row.expiresAt,
						},
						{ ...changes, groupIds },
					);
					if (!diff.changed) continue;
					await tx
						.update(apiKeys)
						.set({ ...changes, updatedAt: now, updatedBy: "root" })
						.where(eq(apiKeys.id, row.id));
					if (selectedGroups !== undefined) {
						await tx
							.delete(apiKeyGroups)
							.where(eq(apiKeyGroups.apiKeyId, row.id));
						if (groupIds.length)
							await tx
								.insert(apiKeyGroups)
								.values(
									groupIds.map((groupId) => ({ apiKeyId: row.id, groupId })),
								);
					}
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "api-key.updated",
						targetType: "api-key",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
				}
				return { data: { ids } };
			},
		);
	}
	async enable(input: $ApiKeyAction, operation: $Operation) {
		return this.setEnabled(input, operation, true);
	}
	async disable(input: $ApiKeyAction, operation: $Operation) {
		return this.setEnabled(input, operation, false);
	}
	private async setEnabled(
		input: $ApiKeyAction,
		operation: $Operation,
		enabled: boolean,
	) {
		this.root(operation);
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			`api-key.${enabled ? "enable" : "disable"}`,
			input,
			async (tx, now) => {
				for (const row of await this.lock(tx, ids)) {
					if (row.enabled === enabled) continue;
					await tx
						.update(apiKeys)
						.set({ enabled, updatedAt: now, updatedBy: "root" })
						.where(eq(apiKeys.id, row.id));
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: `api-key.${enabled ? "enabled" : "disabled"}`,
						targetType: "api-key",
						targetId: row.id,
						reason: input.reason,
						before: { enabled: row.enabled },
						after: { enabled },
					});
				}
				return { data: { ids } };
			},
		);
	}
	async delete(input: $ApiKeyDelete, operation: $Operation) {
		this.root(operation);
		if (!input.confirm || !input.reason) throw new HttpError("INVALID_REQUEST");
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"api-key.delete",
			input,
			async (tx) => {
				const rows = await this.lock(tx, ids);
				const grants = await this.grants(tx, ids);
				for (const row of rows) {
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "api-key.deleted",
						targetType: "api-key",
						targetId: row.id,
						reason: input.reason,
						before: this.view(row, grants.get(row.id) ?? []),
					});
					await tx.delete(apiKeys).where(eq(apiKeys.id, row.id));
				}
				return { data: { ids } };
			},
		);
	}
	async rotate(input: $ApiKeyAction, operation: $Operation) {
		this.root(operation);
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"api-key.rotate",
			input,
			async (tx, now) => {
				const data = [];
				for (const row of await this.lock(tx, ids)) {
					let generated = this.keys.api(row.id);
					for (
						let attempt = 1;
						this.hashes.hash(generated.secret) === row.secretHash &&
						attempt < 5;
						attempt++
					)
						generated = this.keys.api(row.id);
					if (this.hashes.hash(generated.secret) === row.secretHash)
						throw new Error("Credential generation collision limit reached");
					await tx
						.update(apiKeys)
						.set({
							secretHash: this.hashes.hash(generated.secret),
							updatedAt: now,
							updatedBy: "root",
						})
						.where(eq(apiKeys.id, row.id));
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "api-key.rotated",
						targetType: "api-key",
						targetId: row.id,
						reason: input.reason,
					});
					data.push({ id: row.id, credential: generated.credential });
				}
				return { data };
			},
			{ secretIds: (result) => result.data.map((row) => row.id) },
		);
	}
	private view(row: $ApiKey, groupIds: string[]) {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			scopes: row.scopes,
			allGroups: row.allGroups,
			groupIds,
			enabled: row.enabled,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
		};
	}
	private root(operation: $Operation) {
		if (operation.principal.kind !== "root") throw new HttpError("FORBIDDEN");
	}
	private validateScopes(scopes: string[]) {
		try {
			return this.scopes.validate(scopes);
		} catch {
			throw new HttpError("INVALID_REQUEST", {
				scopes: "Unknown, duplicate or overlapping scopes",
			});
		}
	}
	private groupIds(ids: string[]) {
		const normalized = ids.map((id) => id.toLowerCase()).sort();
		if (
			normalized.length > 100 ||
			new Set(normalized).size !== normalized.length ||
			normalized.some(
				(id) =>
					!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
						id,
					),
			)
		)
			throw new HttpError("INVALID_REQUEST", {
				groupIds: "Expected at most 100 unique group IDs",
			});
		return normalized;
	}
	private async grants(tx: $Transaction, ids: string[]) {
		const result = new Map<string, string[]>();
		if (!ids.length) return result;
		const grants = await tx
			.select()
			.from(apiKeyGroups)
			.where(inArray(apiKeyGroups.apiKeyId, ids))
			.orderBy(asc(apiKeyGroups.groupId));
		for (const grant of grants) {
			const selected = result.get(grant.apiKeyId) ?? [];
			selected.push(grant.groupId);
			result.set(grant.apiKeyId, selected);
		}
		return result;
	}
	private async lock(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(apiKeys)
			.where(inArray(apiKeys.id, ids))
			.orderBy(asc(apiKeys.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}
}
