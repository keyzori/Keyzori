import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import { deliveries } from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type {
	$Webhook,
	$WebhookAction,
	$WebhookCreate,
	$WebhookDelete,
	$WebhookDelivery,
	$WebhookUpdate,
} from "../../types/webhookManagement";
import type { AuditService } from "../audits/AuditService";
import type { SettingsService } from "../settings/SettingsService";
import { webhookEvents } from "./events";

export class WebhookService {
	private readonly policy = new InputPolicy();
	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly settings: SettingsService,
		private readonly idem: IdempotencyService,
	) {}

	async create(input: $WebhookCreate, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:create");
		const url = this.url(input.url);
		const events = this.subscriptions(input.events);
		return this.idem.admin(
			operation,
			"webhook.create",
			input,
			async (tx, now) => {
				const [row] = await tx
					.insert(webhooks)
					.values({
						id: Bun.randomUUIDv7(),
						url,
						events,
						enabled: false,
						createdBy: operation.principal.id,
						updatedBy: operation.principal.id,
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				if (!row) throw new Error("Webhook creation returned no record");
				await this.audit.record(tx, {
					...operation,
					actor: operation.principal,
					action: "webhook.created",
					targetType: "webhook",
					targetId: row.id,
					after: this.public(row),
				});
				return { data: this.public(row) };
			},
			{ topology: "write" },
		);
	}

	async read(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:read");
		return this.database.transaction(
			async (tx) => {
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					params,
					webhooks,
					settings.defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(webhooks)
					.where(query.where)
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id) {
					const row = rows[0];
					if (!row) throw new HttpError("NOT_FOUND");
					return { data: this.public(row) };
				}
				const selected = rows.slice(0, query.limit);
				const last = selected.at(-1);
				return {
					data: selected.map((row) => this.public(row)),
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async update(input: $WebhookUpdate, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:update");
		const ids = this.policy.ids(input.ids);
		const url =
			input.changes.url === undefined ? undefined : this.url(input.changes.url);
		const events =
			input.changes.events === undefined
				? undefined
				: this.subscriptions(input.changes.events);
		return this.idem.admin(
			operation,
			"webhook.update",
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				const data = [];
				for (const row of rows) {
					const after = { url: url ?? row.url, events: events ?? row.events };
					const diff = this.audit.changes(
						{ url: row.url, events: row.events },
						after,
					);
					if (!diff.changed) {
						data.push(this.public(row));
						continue;
					}
					const [updated] = await tx
						.update(webhooks)
						.set({
							...after,
							updatedBy: operation.principal.id,
							updatedAt: now,
						})
						.where(eq(webhooks.id, row.id))
						.returning();
					if (!updated) throw new Error("Webhook update returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "webhook.updated",
						targetType: "webhook",
						targetId: row.id,
						reason: input.reason,
						before: diff.before,
						after: diff.after,
					});
					data.push(this.public(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	enable(input: $WebhookAction, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:enable");
		return this.setEnabled(input, operation, true);
	}

	disable(input: $WebhookAction, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:disable");
		return this.setEnabled(input, operation, false);
	}

	async delete(input: $WebhookDelete, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:delete");
		const ids = this.policy.ids(input.ids);
		if (input.confirm !== true || !input.reason)
			throw new HttpError("INVALID_REQUEST");
		return this.idem.admin(
			operation,
			"webhook.delete",
			input,
			async (tx) => {
				const rows = await this.targets(tx, ids);
				await tx
					.update(deliveries)
					.set({ state: "cancelled" })
					.where(
						and(
							inArray(deliveries.webhookId, ids),
							eq(deliveries.state, "pending"),
						),
					);
				for (const row of rows) {
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action: "webhook.deleted",
						targetType: "webhook",
						targetId: row.id,
						reason: input.reason,
						before: this.public(row),
					});
					await tx.delete(webhooks).where(eq(webhooks.id, row.id));
				}
				return { data: { ids } };
			},
			{ topology: "write" },
		);
	}

	async deliveryHistory(params: URLSearchParams, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:read");
		const filters: SQL[] = [];
		const remaining = new URLSearchParams(params);
		for (const key of params.keys())
			if (params.getAll(key).length !== 1)
				throw new HttpError("INVALID_REQUEST");
		const webhookId = params.get("webhookId");
		if (webhookId !== null) {
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					webhookId,
				)
			)
				throw new HttpError("INVALID_REQUEST");
			filters.push(eq(deliveries.webhookId, webhookId));
			remaining.delete("webhookId");
		}
		const state = params.get("state");
		if (state !== null) {
			if (
				state !== "pending" &&
				state !== "claimed" &&
				state !== "succeeded" &&
				state !== "failed" &&
				state !== "cancelled"
			)
				throw new HttpError("INVALID_REQUEST");
			filters.push(eq(deliveries.state, state));
			remaining.delete("state");
		}
		if (params.has("sort") && params.get("sort") !== "createdAt")
			throw new HttpError("INVALID_REQUEST");
		return this.database.transaction(
			async (tx) => {
				const settings = await this.settings.read(tx);
				const query = new ResourceQuery(
					remaining,
					{
						id: deliveries.id,
						createdAt: deliveries.createdAt,
						updatedAt: deliveries.createdAt,
					},
					settings.defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(deliveries)
					.where(and(query.where, ...filters))
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id) {
					const row = rows[0];
					if (!row) throw new HttpError("NOT_FOUND");
					return { data: this.delivery(row) };
				}
				const selected = rows.slice(0, query.limit);
				const last = selected.at(-1);
				return {
					data: selected.map((row) => this.delivery(row)),
					nextCursor:
						rows.length > query.limit && last
							? query.cursor({
									id: last.id,
									createdAt: last.createdAt,
									updatedAt: last.createdAt,
								})
							: null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	private async targets(tx: $Transaction, ids: string[]) {
		const rows = await tx
			.select()
			.from(webhooks)
			.where(inArray(webhooks.id, ids))
			.orderBy(asc(webhooks.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		return rows;
	}

	private setEnabled(
		input: $WebhookAction,
		operation: $Operation,
		enabled: boolean,
	) {
		const ids = this.policy.ids(input.ids);
		const action = enabled ? "webhook.enabled" : "webhook.disabled";
		return this.idem.admin(
			operation,
			action,
			input,
			async (tx, now) => {
				const rows = await this.targets(tx, ids);
				if (!enabled)
					await tx
						.update(deliveries)
						.set({ state: "cancelled" })
						.where(
							and(
								inArray(deliveries.webhookId, ids),
								eq(deliveries.state, "pending"),
							),
						);
				const data = [];
				for (const row of rows) {
					if (row.enabled === enabled) {
						data.push(this.public(row));
						continue;
					}
					const [updated] = await tx
						.update(webhooks)
						.set({ enabled, updatedBy: operation.principal.id, updatedAt: now })
						.where(eq(webhooks.id, row.id))
						.returning();
					if (!updated)
						throw new Error("Webhook state change returned no record");
					await this.audit.record(tx, {
						...operation,
						actor: operation.principal,
						action,
						targetType: "webhook",
						targetId: row.id,
						reason: input.reason,
						before: { enabled: row.enabled },
						after: { enabled },
					});
					data.push(this.public(updated));
				}
				return { data };
			},
			{ topology: "write" },
		);
	}

	private url(value: string) {
		if (
			!value ||
			value.length > 8192 ||
			/[\s\\]/u.test(value) ||
			!/^https?:\/\/[^/]/i.test(value)
		)
			throw new HttpError("INVALID_REQUEST");
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new HttpError("INVALID_REQUEST");
		}
		if (
			!url.hostname ||
			url.username ||
			url.password ||
			url.hash ||
			(url.protocol !== "http:" && url.protocol !== "https:")
		)
			throw new HttpError("INVALID_REQUEST");
		return url.href;
	}

	private subscriptions(events: string[]) {
		if (
			!events.length ||
			new Set(events).size !== events.length ||
			(events.includes("*") && events.length !== 1) ||
			events.some(
				(event) =>
					event !== "*" && !webhookEvents.some((known) => known === event),
			)
		)
			throw new HttpError("INVALID_REQUEST");
		const selected: $WebhookCreate["events"] = [];
		for (const event of events) {
			if (event === "*") {
				selected.push(event);
				continue;
			}
			const known = webhookEvents.find((candidate) => candidate === event);
			if (!known) throw new HttpError("INVALID_REQUEST");
			selected.push(known);
		}
		return selected.sort();
	}

	private public(row: $Webhook) {
		return {
			id: row.id,
			url: row.url,
			events: this.subscriptions(row.events),
			enabled: row.enabled,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}

	private delivery(row: $WebhookDelivery) {
		return {
			id: row.id,
			webhookId: row.webhookId,
			eventId: row.payload.id,
			event: row.payload.event,
			state: row.state,
			attemptedAt: row.attemptedAt?.toISOString() ?? null,
			status: row.status,
			error: row.error,
			createdAt: row.createdAt.toISOString(),
		};
	}
}
