import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { webhooks } from "../../core/database/schema/webhooks";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { eventState } from "../../core/database/schema/events";
import { HttpError } from "../../core/http/HttpError";
import { InputPolicy } from "../../core/http/InputPolicy";
import { ResourceQuery } from "../../core/http/ResourceQuery";
import { allowedEvents, eventScope } from "../../core/auth/EventAuthorization";
import { actions } from "../../core/auth/scopes";
import { WebhookAuthority } from "./WebhookAuthority";
import { WebhookSecrets } from "./WebhookSecrets";
import {
	WebhookTransport,
	type $WebhookPrivateDestination,
} from "./WebhookTransport";
import type { AuthService } from "../../core/auth/AuthService";
import type { Database } from "../../core/database/Database";
import type { IdempotencyService } from "../../core/security/IdempotencyService";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type { $Principal } from "../../types/auth";
import type {
	$Webhook,
	$WebhookAction,
	$WebhookCreate,
	$WebhookDelete,
	$WebhookDelivery,
	$WebhookRecovery,
	$WebhookUpdate,
} from "../../types/webhookManagement";
import type { AuditService } from "../audits/AuditService";
import type { SettingsService } from "../settings/SettingsService";

export class WebhookService {
	private readonly policy = new InputPolicy();
	private readonly authority;
	private readonly secrets;
	private readonly transport;
	constructor(
		private readonly database: Database,
		private readonly auth: AuthService,
		private readonly audit: AuditService,
		private readonly settings: SettingsService,
		private readonly idem: IdempotencyService,
		options: {
			encryptionKey?: string;
			allowedOrigins?: readonly string[];
			privateDestinations?: readonly $WebhookPrivateDestination[];
		} = {},
	) {
		this.authority = new WebhookAuthority(auth);
		this.secrets = new WebhookSecrets(options.encryptionKey);
		this.transport = new WebhookTransport(
			options.allowedOrigins,
			undefined,
			undefined,
			options.privateDestinations,
		);
	}

	async create(input: $WebhookCreate, operation: $Operation) {
		this.auth.require(operation.principal, "webhooks:create");
		const url = this.transport.url(input.url).href;
		const groupIds = this.groupIds(input.groupIds ?? []);
		const allGroups = input.allGroups ?? false;
		let principal = operation.principal;
		return this.idem.admin(
			operation,
			"webhook.create",
			input,
			async (tx, now) => {
				await tx.execute(sql`select pg_advisory_xact_lock(6284, 8)`);
				const [count] = await tx
					.select({ count: sql<number>`count(*)::integer` })
					.from(webhooks);
				if (!count || count.count >= 100)
					throw new HttpError("CONFLICT", {
						webhooks: "Endpoint limit reached (100)",
					});
				const issued = this.secrets.issue();
				const [state] = await tx
					.select()
					.from(eventState)
					.where(eq(eventState.id, 1));
				const [row] = await tx
					.insert(webhooks)
					.values({
						id: Bun.randomUUIDv7(),
						url,
						events: this.authority.subscriptions(principal, input.events),
						allGroups,
						groupIds,
						ownerApiKeyId: principal.kind === "api" ? principal.id : null,
						ownerCredentialHash:
							principal.kind === "api" ? principal.credentialHash : null,
						secretCiphertext: issued.secretCiphertext,
						signingKeyId: issued.signingKeyId,
						lastSequence: state?.sequence ?? 0n,
						createdBy: principal.id,
						updatedBy: principal.id,
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				if (!row) throw new Error("Webhook creation failed");
				await this.record(
					tx,
					operation,
					"webhook.created",
					row,
					undefined,
					this.public(row),
				);
				return { data: this.public(row), secret: issued.secret };
			},
			{
				secretIds: (result) => [result.data.id],
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						"webhooks:create",
					);
					this.authority.selection(
						principal,
						this.authority.subscriptions(principal, input.events),
						allGroups,
						groupIds,
					);
					return principal;
				},
			},
		);
	}

	async read(params: URLSearchParams, operation: $Operation) {
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"webhooks:read",
				);
				this.auth.require(principal, "events:read");
				const query = new ResourceQuery(
					params,
					webhooks,
					(await this.settings.read(tx)).defaultPageLimit,
				);
				const rows = await tx
					.select()
					.from(webhooks)
					.where(and(query.where, this.authority.visibility(principal)))
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				const visible = (row: $Webhook) => {
					try {
						this.authority.selection(
							principal,
							row.events,
							row.allGroups,
							row.groupIds,
						);
						return true;
					} catch {
						return false;
					}
				};
				if (query.id) {
					const row = rows[0];
					if (!row || !visible(row)) throw new HttpError("NOT_FOUND");
					return { data: this.public(row) };
				}
				const page = rows.slice(0, query.limit);
				const last = page.at(-1);
				return {
					data: page.filter(visible).map((row) => this.public(row)),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last ? query.cursor(last) : null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	async update(input: $WebhookUpdate, operation: $Operation) {
		const ids = this.policy.ids(input.ids);
		const url =
			input.changes.url === undefined
				? undefined
				: this.transport.url(input.changes.url).href;
		const groupIds =
			input.changes.groupIds === undefined
				? undefined
				: this.groupIds(input.changes.groupIds);
		let principal = operation.principal;
		return this.idem.admin(
			operation,
			"webhook.update",
			input,
			async (tx, now) => {
				const data = [];
				for (const row of await this.targets(tx, ids, principal)) {
					const owner = await this.authority.owner(tx, row, true);
					const changes = {
						url: url ?? row.url,
						events:
							input.changes.events === undefined
								? row.events
								: this.authority.subscriptions(principal, input.changes.events),
						allGroups: input.changes.allGroups ?? row.allGroups,
						groupIds: groupIds ?? row.groupIds,
					};
					this.authority.selection(
						owner,
						changes.events,
						changes.allGroups,
						changes.groupIds,
					);
					this.authority.selection(
						principal,
						changes.events,
						changes.allGroups,
						changes.groupIds,
					);
					const diff = this.audit.changes(
						{
							url: row.url,
							events: row.events,
							allGroups: row.allGroups,
							groupIds: row.groupIds,
						},
						changes,
					);
					if (!diff.changed) {
						data.push(this.public(row));
						continue;
					}
					await this.cancel(tx, row.id);
					const [updated] = await tx
						.update(webhooks)
						.set({
							...changes,
							enabled: false,
							version: row.version + 1,
							lastError: null,
							updatedAt: now,
							updatedBy: principal.id,
							ownerCredentialHash:
								owner.kind === "api" ? owner.credentialHash : null,
						})
						.where(eq(webhooks.id, row.id))
						.returning();
					if (!updated) throw new Error("Webhook update failed");
					await this.record(
						tx,
						operation,
						"webhook.updated",
						row,
						diff.before,
						{ ...diff.after, enabled: false },
						input.reason,
					);
					data.push(this.public(updated));
				}
				return { data };
			},
			{
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						"webhooks:update",
					);
					for (const row of await this.targets(tx, ids, principal))
						this.authority.selection(
							principal,
							row.events,
							row.allGroups,
							row.groupIds,
						);
					return principal;
				},
			},
		);
	}

	enable(input: $WebhookAction, operation: $Operation) {
		return this.setEnabled(input, operation, true);
	}
	disable(input: $WebhookAction, operation: $Operation) {
		return this.setEnabled(input, operation, false);
	}
	private setEnabled(
		input: $WebhookAction,
		operation: $Operation,
		enabled: boolean,
	) {
		const ids = this.policy.ids(input.ids);
		let principal = operation.principal;
		return this.idem.admin(
			operation,
			`webhook.${enabled ? "enable" : "disable"}`,
			input,
			async (tx, now) => {
				const [state] = await tx
					.select()
					.from(eventState)
					.where(eq(eventState.id, 1));
				const data = [];
				for (const row of await this.targets(tx, ids, principal)) {
					const owner = enabled
						? await this.authority.owner(tx, row, true)
						: undefined;
					if (owner) {
						this.authority.selection(
							owner,
							row.events,
							row.allGroups,
							row.groupIds,
						);
						this.secrets.decrypt(row.secretCiphertext);
					}
					if (
						row.enabled === enabled &&
						(owner?.kind !== "api" ||
							owner.credentialHash === row.ownerCredentialHash)
					) {
						data.push(this.public(row));
						continue;
					}
					if (!enabled) await this.cancel(tx, row.id);
					const [updated] = await tx
						.update(webhooks)
						.set({
							enabled,
							updatedAt: now,
							updatedBy: principal.id,
							lastSequence: enabled
								? (state?.sequence ?? 0n)
								: row.lastSequence,
							ownerCredentialHash:
								owner?.kind === "api"
									? owner.credentialHash
									: row.ownerCredentialHash,
							lastError: null,
						})
						.where(eq(webhooks.id, row.id))
						.returning();
					if (!updated) throw new Error("Webhook state update failed");
					await this.record(
						tx,
						operation,
						`webhook.${enabled ? "enabled" : "disabled"}`,
						row,
						{ enabled: row.enabled },
						{ enabled },
						input.reason,
					);
					data.push(this.public(updated));
				}
				return { data };
			},
			{
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						`webhooks:${enabled ? "enable" : "disable"}`,
					);
					for (const row of await this.targets(tx, ids, principal))
						this.authority.selection(
							principal,
							row.events,
							row.allGroups,
							row.groupIds,
						);
					return principal;
				},
			},
		);
	}

	async delete(input: $WebhookDelete, operation: $Operation) {
		if (!input.confirm || !input.reason) throw new HttpError("INVALID_REQUEST");
		const ids = this.policy.ids(input.ids);
		let principal = operation.principal;
		return this.idem.admin(
			operation,
			"webhook.delete",
			input,
			async (tx) => {
				for (const row of await this.targets(tx, ids, principal)) {
					await this.cancel(tx, row.id);
					await this.record(
						tx,
						operation,
						"webhook.deleted",
						row,
						this.public(row),
						undefined,
						input.reason,
					);
					await tx.delete(webhooks).where(eq(webhooks.id, row.id));
				}
				return { data: { ids } };
			},
			{
				scope: "webhooks:delete",
				authority: async (tx, current) => {
					const rows = await this.targets(tx, ids, current);
					const required = new Set([
						"events:read",
						...rows.flatMap((row) => row.events.map(eventScope)),
					]);
					return {
						groupIds: [...new Set(rows.flatMap((row) => row.groupIds))],
						allGroups: rows.some((row) => row.allGroups),
						ownerId: current.kind === "api" ? current.id : undefined,
						scopes: actions.filter((scope) => required.has(scope)),
					};
				},
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						"webhooks:delete",
					);
					for (const row of await this.targets(tx, ids, principal))
						this.authority.selection(
							principal,
							row.events,
							row.allGroups,
							row.groupIds,
						);
					return principal;
				},
			},
		);
	}

	async rotateSecret(input: $WebhookAction, operation: $Operation) {
		const ids = this.policy.ids(input.ids);
		let principal = operation.principal;
		return this.idem.admin(
			operation,
			"webhook.rotate-secret",
			input,
			async (tx, now) => {
				const data = [];
				for (const row of await this.targets(tx, ids, principal)) {
					const owner = await this.authority.owner(tx, row, true);
					this.authority.selection(
						owner,
						row.events,
						row.allGroups,
						row.groupIds,
					);
					const issued = this.secrets.issue();
					await tx
						.update(webhooks)
						.set({
							secretCiphertext: issued.secretCiphertext,
							signingKeyId: issued.signingKeyId,
							updatedAt: now,
							updatedBy: principal.id,
						})
						.where(eq(webhooks.id, row.id));
					await this.record(
						tx,
						operation,
						"webhook.updated",
						row,
						{ signingKeyId: row.signingKeyId },
						{ signingKeyId: issued.signingKeyId },
						input.reason,
					);
					data.push({
						id: row.id,
						signingKeyId: issued.signingKeyId,
						secret: issued.secret,
					});
				}
				return { data };
			},
			{
				secretIds: (result) => result.data.map((row) => row.id),
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						"webhooks:rotate-secret",
					);
					for (const row of await this.targets(tx, ids, principal))
						this.authority.selection(
							principal,
							row.events,
							row.allGroups,
							row.groupIds,
						);
					return principal;
				},
			},
		);
	}

	async deliveryHistory(params: URLSearchParams, operation: $Operation) {
		return this.database.transaction(
			async (tx) => {
				const principal = await this.auth.authorize(
					tx,
					operation.principal,
					"webhooks:read",
				);
				this.auth.require(principal, "events:read");
				const remaining = new URLSearchParams(params);
				const filters: SQL[] = [];
				for (const key of params.keys())
					if (params.getAll(key).length !== 1)
						throw new HttpError("INVALID_REQUEST");
				const webhookId = params.get("webhookId");
				if (webhookId !== null) {
					this.groupIds([webhookId]);
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
				const query = new ResourceQuery(
					remaining,
					{
						id: deliveries.id,
						createdAt: deliveries.createdAt,
						updatedAt: deliveries.createdAt,
					},
					50,
				);
				const rows = await tx
					.select({ delivery: deliveries })
					.from(deliveries)
					.leftJoin(webhooks, eq(webhooks.id, deliveries.webhookId))
					.where(
						and(
							query.where,
							...filters,
							this.auth.groupFilter(principal, deliveries.groupId),
							this.authority.historyFilter(principal),
							principal.kind === "api"
								? eq(webhooks.ownerApiKeyId, principal.id)
								: undefined,
							principal.kind === "api" && !principal.allGroups
								? eq(deliveries.global, false)
								: undefined,
							inArray(
								sql<string>`${deliveries.payload}->>'event'`,
								allowedEvents(this.auth, principal),
							),
						),
					)
					.orderBy(...query.order)
					.limit(query.id ? 1 : query.limit + 1);
				if (query.id) {
					const row = rows[0];
					if (!row) throw new HttpError("NOT_FOUND");
					return { data: this.delivery(row.delivery) };
				}
				const page = rows.slice(0, query.limit);
				const last = page.at(-1)?.delivery;
				return {
					data: page.map((row) => this.delivery(row.delivery)),
					pageLimit: query.limit,
					nextCursor:
						rows.length > query.limit && last
							? query.cursor({ ...last, updatedAt: last.createdAt })
							: null,
				};
			},
			"read",
			operation.deadlineAt,
		);
	}

	/** Explicit replay creates a new delivery ID; receivers may already have handled the event. */
	replay(input: $WebhookRecovery, operation: $Operation) {
		return this.requeue(input, operation, true);
	}
	/** Recovery keeps the original ID, signing key, retry budget and expiry. */
	recover(input: $WebhookRecovery, operation: $Operation) {
		return this.requeue(input, operation, false);
	}
	private async requeue(
		input: $WebhookRecovery,
		operation: $Operation,
		replay: boolean,
	) {
		if (!input.confirm || !input.reason) throw new HttpError("INVALID_REQUEST");
		this.policy.idempotency(operation.idempotencyKey, true);
		const ids = this.policy.ids(input.ids);
		let principal = operation.principal;
		const action = replay ? "replay" : "recover";
		return this.idem.admin(
			operation,
			`webhook.${action}`,
			input,
			async (tx, now) => {
				const rows = await this.deliveryTargets(tx, ids, principal);
				const data = [];
				for (const { delivery, endpoint } of rows) {
					const owner = await this.authority.owner(tx, endpoint);
					this.authority.selection(
						owner,
						endpoint.events,
						endpoint.allGroups,
						endpoint.groupIds,
					);
					if (
						!this.authority.allowsEvent(
							owner,
							endpoint,
							delivery.payload.event,
							delivery.groupId,
							delivery.global,
							delivery,
						)
					)
						throw new HttpError("FORBIDDEN");
					if (!endpoint.enabled)
						throw new HttpError("CONFLICT", {
							webhook: "Enable the endpoint before recovery or replay",
						});
					const terminal = ["succeeded", "failed", "cancelled"].includes(
						delivery.state,
					);
					if (replay !== terminal)
						throw new HttpError("CONFLICT", {
							delivery: replay
								? "Only terminal deliveries can be replayed"
								: "Only pending or expired claims can be recovered",
						});
					let result: $WebhookDelivery;
					if (replay) {
						this.secrets.decrypt(endpoint.secretCiphertext);
						const [backlog] = await tx
							.select({ count: sql<number>`count(*)::integer` })
							.from(deliveries)
							.where(
								and(
									eq(deliveries.webhookId, endpoint.id),
									inArray(deliveries.state, ["pending", "claimed"]),
								),
							);
						if (!backlog || backlog.count >= 1000)
							throw new HttpError("CONFLICT", {
								webhook: "Endpoint backlog is full (1000)",
							});
						const [created] = await tx
							.insert(deliveries)
							.values({
								id: Bun.randomUUIDv7(),
								replayOf: delivery.id,
								webhookId: endpoint.id,
								eventId: delivery.eventId,
								groupId: delivery.groupId,
								requiredGroupIds: delivery.requiredGroupIds,
								requiresAllGroups: delivery.requiresAllGroups,
								global: delivery.global,
								payload: delivery.payload,
								endpointVersion: endpoint.version,
								url: endpoint.url,
								secretCiphertext: endpoint.secretCiphertext,
								signingKeyId: endpoint.signingKeyId,
								nextAttemptAt: now,
								expiresAt: new Date(now.getTime() + 86400000),
								createdAt: now,
							})
							.returning();
						if (!created) throw new Error("Webhook replay failed");
						result = created;
					} else {
						if (
							delivery.endpointVersion !== endpoint.version ||
							delivery.expiresAt <= now ||
							delivery.attempts >= 8 ||
							(delivery.state === "claimed" &&
								delivery.leaseUntil &&
								delivery.leaseUntil > now)
						)
							throw new HttpError("CONFLICT", {
								delivery:
									"Recovery requires a current destination, remaining retry budget and no active lease",
							});
						this.secrets.decrypt(delivery.secretCiphertext);
						if (delivery.claimToken)
							await tx
								.update(deliveryAttempts)
								.set({
									completedAt: now,
									error: sql`case when ${deliveryAttempts.sendStartedAt} is null then 'manual_recovery_before_send' else 'manual_recovery_outcome_unknown' end`,
								})
								.where(
									and(
										eq(deliveryAttempts.id, delivery.claimToken),
										isNull(deliveryAttempts.completedAt),
									),
								);
						const [recovered] = await tx
							.update(deliveries)
							.set({
								state: "pending",
								nextAttemptAt: now,
								claimToken: null,
								leaseUntil: null,
								error: null,
							})
							.where(eq(deliveries.id, delivery.id))
							.returning();
						if (!recovered) throw new Error("Webhook recovery failed");
						result = recovered;
					}
					await this.record(
						tx,
						operation,
						`webhook.delivery.${replay ? "replayed" : "recovered"}`,
						endpoint,
						{ deliveryId: delivery.id, state: delivery.state },
						{
							deliveryId: result.id,
							eventId: result.eventId,
							state: result.state,
						},
						input.reason,
					);
					data.push(this.delivery(result));
				}
				return { data };
			},
			{
				authorize: async (tx) => {
					principal = await this.auth.authorize(
						tx,
						operation.principal,
						`webhooks:${action}`,
					);
					await this.deliveryTargets(tx, ids, principal);
					return principal;
				},
			},
		);
	}
	private async deliveryTargets(
		tx: $Transaction,
		ids: string[],
		principal: $Principal,
	) {
		return this.authority.deliveryTargets(tx, ids, principal);
	}

	private async targets(
		tx: $Transaction,
		ids: string[],
		principal: $Principal,
	) {
		return this.authority.targets(tx, ids, principal);
	}
	private async cancel(tx: $Transaction, id: string) {
		await this.authority.cancel(tx, id);
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
			throw new HttpError("INVALID_REQUEST");
		return normalized;
	}
	private record(
		tx: $Transaction,
		operation: $Operation,
		action: string,
		row: $Webhook,
		before?: Record<string, unknown>,
		after?: Record<string, unknown>,
		reason?: string,
	) {
		return this.audit.record(tx, {
			...operation,
			actor: operation.principal,
			action,
			targetType: "webhook",
			targetId: row.id,
			before,
			after,
			reason,
		});
	}
	private public(row: $Webhook) {
		return {
			id: row.id,
			url: row.url,
			events: row.events,
			enabled: row.enabled,
			allGroups: row.allGroups,
			groupIds: row.groupIds,
			signingKeyId: row.signingKeyId,
			version: row.version,
			lastError: row.lastError,
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
			eventId: row.eventId,
			replayOf: row.replayOf,
			event: row.payload.event,
			state: row.state,
			attempts: row.attempts,
			attemptedAt: row.attemptedAt?.toISOString() ?? null,
			nextAttemptAt: row.nextAttemptAt.toISOString(),
			expiresAt: row.expiresAt.toISOString(),
			status: row.status,
			error: row.error,
			createdAt: row.createdAt.toISOString(),
		};
	}
}
