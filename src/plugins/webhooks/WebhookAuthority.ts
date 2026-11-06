import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { apiKeys } from "../../core/database/schema/apiKeys";
import { webhooks } from "../../core/database/schema/webhooks";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import {
	eventScope,
	allowedEvents,
	allowsHistoricalGroups,
	historicalGroupFilter,
} from "../../core/auth/EventAuthorization";
import { HttpError } from "../../core/http/HttpError";
import type { AuthService } from "../../core/auth/AuthService";
import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";
import type { $Webhook, $WebhookDelivery } from "../../types/webhookManagement";

export class WebhookAuthority {
	constructor(private readonly auth: AuthService) {}
	selection(
		principal: $Principal,
		events: readonly string[],
		allGroups: boolean,
		groupIds: readonly string[],
	) {
		this.auth.require(principal, "events:read");
		if (allGroups) {
			this.auth.requireAllGroups(principal);
			if (groupIds.length) throw new HttpError("INVALID_REQUEST");
		} else
			for (const groupId of groupIds)
				this.auth.requireGroup(principal, groupId);
		if (!events.length || new Set(events).size !== events.length)
			throw new HttpError("INVALID_REQUEST");
		for (const event of events) {
			const scope = eventScope(event);
			if (!scope) throw new HttpError("INVALID_REQUEST");
			this.auth.require(principal, scope);
		}
	}
	subscriptions(principal: $Principal, events: readonly string[]) {
		const permitted = allowedEvents(this.auth, principal);
		if (events.length === 1 && events[0] === "*") {
			if (!permitted.length) throw new HttpError("FORBIDDEN");
			return permitted;
		}
		if (
			!events.length ||
			new Set(events).size !== events.length ||
			events.some((event) => !permitted.some((known) => known === event))
		)
			throw new HttpError("FORBIDDEN");
		return permitted.filter((event) => events.includes(event));
	}
	ownership(principal: $Principal, webhook: $Webhook) {
		if (principal.kind === "api" && webhook.ownerApiKeyId !== principal.id)
			throw new HttpError("NOT_FOUND");
	}
	async targets(tx: $Transaction, ids: string[], principal: $Principal) {
		const where = and(
			inArray(webhooks.id, ids),
			principal.kind === "api"
				? eq(webhooks.ownerApiKeyId, principal.id)
				: undefined,
		);
		const snapshots = await tx
			.select({ ownerId: webhooks.ownerApiKeyId })
			.from(webhooks)
			.where(where);
		const owners = [
			...new Set(
				snapshots.flatMap((row) => (row.ownerId ? [row.ownerId] : [])),
			),
		].sort();
		// Lock even inactive owners before endpoints; disable/delete may still administer them.
		if (owners.length)
			await tx
				.select({ id: apiKeys.id })
				.from(apiKeys)
				.where(inArray(apiKeys.id, owners))
				.orderBy(asc(apiKeys.id))
				.for("share");
		const rows = await tx
			.select()
			.from(webhooks)
			.where(where)
			.orderBy(asc(webhooks.id))
			.for("update");
		if (rows.length !== ids.length) throw new HttpError("NOT_FOUND");
		for (const row of rows) this.ownership(principal, row);
		return rows;
	}
	async deliveryTargets(
		tx: $Transaction,
		ids: string[],
		principal: $Principal,
	) {
		this.auth.require(principal, "events:read");
		const visible = await tx
			.select({ webhookId: deliveries.webhookId })
			.from(deliveries)
			.innerJoin(webhooks, eq(webhooks.id, deliveries.webhookId))
			.where(
				and(
					inArray(deliveries.id, ids),
					this.auth.groupFilter(principal, deliveries.groupId),
					this.historyFilter(principal),
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
			);
		if (visible.length !== ids.length) throw new HttpError("NOT_FOUND");
		const endpoints = await this.targets(
			tx,
			[...new Set(visible.map((row) => row.webhookId))],
			principal,
		);
		for (const endpoint of endpoints)
			this.selection(
				principal,
				endpoint.events,
				endpoint.allGroups,
				endpoint.groupIds,
			);
		const rows = await tx
			.select()
			.from(deliveries)
			.where(inArray(deliveries.id, ids))
			.orderBy(asc(deliveries.id))
			.for("update");
		if (rows.length !== ids.length) throw new HttpError("NOT_FOUND");
		return rows.map((delivery) => {
			const endpoint = endpoints.find((row) => row.id === delivery.webhookId);
			if (
				!endpoint ||
				!this.allowsEvent(
					principal,
					endpoint,
					delivery.payload.event,
					delivery.groupId,
					delivery.global,
					delivery,
				)
			)
				throw new HttpError("FORBIDDEN");
			return { delivery, endpoint };
		});
	}
	visibility(principal: $Principal) {
		if (principal.kind === "root") return undefined;
		const permitted = allowedEvents(this.auth, principal);
		return and(
			eq(webhooks.ownerApiKeyId, principal.id),
			sql`${webhooks.events} <@ ARRAY[${sql.join(
				permitted.map((event) => sql`${event}`),
				sql`, `,
			)}]::text[]`,
			principal.allGroups
				? undefined
				: and(
						eq(webhooks.allGroups, false),
						sql`${webhooks.groupIds} <@ ARRAY[${sql.join(
							principal.groupIds.map((id) => sql`${id}`),
							sql`, `,
						)}]::uuid[]`,
					),
		);
	}
	/** Historical provenance is an additional SQL boundary, including after deletion. */
	historyFilter(principal: $Principal) {
		return historicalGroupFilter(principal, deliveries);
	}
	async owner(
		tx: $Transaction,
		webhook: $Webhook,
		refresh = false,
	): Promise<$Principal> {
		if (!webhook.ownerApiKeyId)
			return { kind: "root", id: "root", name: "Root", scopes: [] };
		let digest = webhook.ownerCredentialHash;
		if (refresh) {
			const [row] = await tx
				.select({ secretHash: apiKeys.secretHash })
				.from(apiKeys)
				.where(eq(apiKeys.id, webhook.ownerApiKeyId));
			digest = row?.secretHash ?? null;
		}
		if (!digest) throw new HttpError("UNAUTHORIZED");
		return this.auth.authorize(
			tx,
			{
				kind: "api",
				id: webhook.ownerApiKeyId,
				name: "Webhook owner",
				scopes: [],
				credentialHash: digest,
				allGroups: false,
				groupIds: [],
			},
			"events:read",
		);
	}
	/** Acquire owner authority before the endpoint lock, matching management lock order. */
	async lock(tx: $Transaction, id: string, mode: "share" | "update") {
		const [snapshot] = await tx
			.select()
			.from(webhooks)
			.where(eq(webhooks.id, id));
		if (!snapshot) return;
		let owner: $Principal | undefined;
		try {
			owner = await this.owner(tx, snapshot);
		} catch (error) {
			if (!this.revoked(error)) throw error;
		}
		const [endpoint] = await tx
			.select()
			.from(webhooks)
			.where(eq(webhooks.id, id))
			.for(mode, { skipLocked: true });
		if (
			!endpoint ||
			endpoint.ownerCredentialHash !== snapshot.ownerCredentialHash
		)
			return;
		return { endpoint, owner };
	}
	revoked(error: unknown) {
		return (
			error instanceof HttpError &&
			(error.status === 401 || error.status === 403)
		);
	}
	/** Endpoint changes fence every outstanding claim, including requests in flight. */
	async cancel(tx: $Transaction, id: string, error = "endpoint_changed") {
		const cancelled = await tx
			.update(deliveries)
			.set({ state: "cancelled", error, claimToken: null, leaseUntil: null })
			.where(
				and(
					eq(deliveries.webhookId, id),
					inArray(deliveries.state, ["pending", "claimed"]),
				),
			)
			.returning({ id: deliveries.id });
		if (cancelled.length)
			await tx
				.update(deliveryAttempts)
				.set({
					completedAt: sql`clock_timestamp()`,
					error: sql`case when ${deliveryAttempts.sendStartedAt} is null then ${`${error}_before_send`} else ${`${error}_outcome_unknown`} end`,
				})
				.where(
					and(
						inArray(
							deliveryAttempts.deliveryId,
							cancelled.map((row) => row.id),
						),
						isNull(deliveryAttempts.completedAt),
					),
				);
	}
	allowsEvent(
		principal: $Principal,
		webhook: $Webhook,
		event: string,
		groupId: string | null,
		global: boolean,
		historical: Pick<
			$WebhookDelivery,
			"requiredGroupIds" | "requiresAllGroups"
		>,
	) {
		if (!allowsHistoricalGroups(principal, historical)) return false;
		if (!webhook.events.some((known) => known === event)) return false;
		const scope = eventScope(event);
		if (!scope) return false;
		try {
			this.auth.require(principal, "events:read");
			this.auth.require(principal, scope);
			this.auth.requireGroup(principal, groupId);
			if (global) this.auth.requireAllGroups(principal);
			return (
				webhook.allGroups ||
				(!global && groupId !== null && webhook.groupIds.includes(groupId))
			);
		} catch {
			return false;
		}
	}
}
