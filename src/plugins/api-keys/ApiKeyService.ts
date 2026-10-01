import { asc, eq, inArray } from "drizzle-orm";
import { apiKeys } from "../../core/database/schema/apiKeys";
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
		this.validateScopes(input.scopes);
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
						scopes: input.scopes,
						secretHash: this.hashes.hash(generated.secret),
						expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
						createdBy: "root",
						updatedBy: "root",
					})
					.returning();
				if (!row) throw new Error("API key creation failed");
				const data = this.view(row);
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
				if (query.id) {
					if (!rows[0]) throw new HttpError("NOT_FOUND");
					return { data: this.view(rows[0]) };
				}
				const page = rows.slice(0, query.limit);
				const last = page.at(-1);
				return {
					data: page.map((row) => this.view(row)),
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
		if (input.changes.scopes) this.validateScopes(input.changes.scopes);
		const ids = this.input.ids(input.ids);
		return this.idempotency.admin(
			operation,
			"api-key.update",
			input,
			async (tx, now) => {
				for (const row of await this.lock(tx, ids)) {
					const changes = {
						name: input.changes.name ?? row.name,
						scopes: input.changes.scopes ?? row.scopes,
						expiresAt:
							input.changes.expiresAt === undefined
								? row.expiresAt
								: input.changes.expiresAt
									? new Date(input.changes.expiresAt)
									: null,
					};
					const diff = this.audit.changes(
						{ name: row.name, scopes: row.scopes, expiresAt: row.expiresAt },
						changes,
					);
					if (!diff.changed) continue;
					await tx
						.update(apiKeys)
						.set({ ...changes, updatedAt: now, updatedBy: "root" })
						.where(eq(apiKeys.id, row.id));
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
				for (const row of await this.lock(tx, ids)) {
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "api-key.deleted",
						targetType: "api-key",
						targetId: row.id,
						reason: input.reason,
						before: this.view(row),
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
					const generated = this.keys.api(row.id);
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
	private view(row: $ApiKey) {
		return {
			id: row.id,
			name: row.name,
			scopes: row.scopes,
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
			this.scopes.validate(scopes);
		} catch {
			throw new HttpError("INVALID_REQUEST", {
				scopes: "Unknown, duplicate or overlapping scopes",
			});
		}
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
