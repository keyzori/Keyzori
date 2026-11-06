import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { activityEvents } from "../../core/database/schema/events";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { HttpError } from "../../core/http/HttpError";
import { WebhookAuthority } from "./WebhookAuthority";
import { WebhookSecrets } from "./WebhookSecrets";
import {
	WebhookTransport,
	type $WebhookPrivateDestination,
} from "./WebhookTransport";
import type { Database } from "../../core/database/Database";
import type { AuthService } from "../../core/auth/AuthService";
import type { Metrics } from "../../core/observability/Metrics";
import type { SettingsService } from "../settings/SettingsService";
import type { $WebhookClaim } from "../../types/webhookManagement";
import type { $Transaction } from "../../types/database";

type Gate =
	"ready" | "lost" | "expired" | "authority_revoked" | "endpoint_unavailable";
type Outcome = {
	status?: number | null;
	error: string | null;
	retry?: boolean;
	cancelled?: boolean;
	retryAfter?: string | null;
};

/** Bounded at-least-once delivery: a receiver may have processed any interrupted send. */
export class WebhookDispatcher {
	private readonly shutdown = new AbortController();
	private running?: Promise<void>;
	private readonly authority;
	private readonly secrets;
	private readonly transport;
	constructor(
		private readonly database: Database,
		private readonly settings: SettingsService,
		private readonly metrics?: Metrics,
		auth?: AuthService,
		encryptionKey?: string,
		allowedOrigins: readonly string[] = [],
		privateDestinations: readonly $WebhookPrivateDestination[] = [],
	) {
		this.authority = auth ? new WebhookAuthority(auth) : undefined;
		this.secrets = new WebhookSecrets(encryptionKey);
		this.transport = new WebhookTransport(
			allowedOrigins,
			undefined,
			undefined,
			privateDestinations,
		);
	}
	runOnce(limit = 10): Promise<void> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError("Webhook batch limit must be between 1 and 100");
		if (this.shutdown.signal.aborted) return Promise.resolve();
		if (this.running) return this.running;
		this.running = this.dispatch(limit).finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
	stop() {
		this.shutdown.abort(new Error("Webhook dispatcher stopped"));
	}
	async drain() {
		await this.running;
	}

	private async dispatch(limit: number) {
		if (!this.authority) throw new HttpError("SERVICE_UNAVAILABLE");
		const endpoints = await this.database.transaction((tx) =>
			tx
				.select({ id: webhooks.id })
				.from(webhooks)
				.where(eq(webhooks.enabled, true))
				.orderBy(
					sql`${webhooks.lastDispatchAt} asc nulls first`,
					asc(webhooks.id),
				)
				.limit(101),
		);
		if (endpoints.length > 100) throw new HttpError("SERVICE_UNAVAILABLE");
		let failures = 0;
		let remaining = limit;
		// A corrupt signing key or failing endpoint must not prevent other cursors progressing.
		await this.parallel(endpoints, async ({ id }) => {
			try {
				await this.enqueue(id);
			} catch {
				failures++;
				await this.endpointError(id, "enqueue_unavailable");
			}
			if (remaining <= 0 || this.shutdown.signal.aborted) return;
			try {
				const candidate = await this.database.transaction(async (tx) => {
					const now = await this.now(tx);
					const [row] = await tx
						.select({ id: deliveries.id })
						.from(deliveries)
						.where(
							and(
								eq(deliveries.webhookId, id),
								or(
									and(
										eq(deliveries.state, "pending"),
										lte(deliveries.nextAttemptAt, now),
									),
									and(
										eq(deliveries.state, "claimed"),
										lte(deliveries.leaseUntil, now),
									),
								),
							),
						)
						.orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id))
						.limit(1);
					return row;
				});
				if (!candidate || remaining <= 0) return;
				remaining--;
				const claim = await this.claim(candidate.id, id);
				if (claim) await this.send(claim);
				else remaining++;
			} catch {
				failures++;
				await this.endpointError(id, "dispatch_unavailable");
			}
		});
		if (failures)
			throw new Error(`${failures} webhook endpoint operations failed`);
	}
	private async parallel<T>(items: T[], work: (item: T) => Promise<void>) {
		const pending = [...items];
		await Promise.all(
			Array.from({ length: Math.min(10, items.length) }, async () => {
				while (!this.shutdown.signal.aborted) {
					const item = pending.shift();
					if (item === undefined) return;
					await work(item);
				}
			}),
		);
	}
	private async endpointError(id: string, error: string) {
		try {
			await this.database.transaction(async (tx) => {
				await tx
					.update(webhooks)
					.set({ lastError: error, lastDispatchAt: await this.now(tx) })
					.where(eq(webhooks.id, id));
			});
		} catch {
			/* A database outage leaves durable work available for a later pass. */
		}
	}

	private async enqueue(id: string) {
		return this.database.transaction(async (tx) => {
			const locked = await this.authority?.lock(tx, id, "update");
			if (!locked?.endpoint.enabled || !this.authority) return;
			const { endpoint, owner } = locked;
			try {
				if (!owner) throw new HttpError("UNAUTHORIZED");
				this.authority.selection(
					owner,
					endpoint.events,
					endpoint.allGroups,
					endpoint.groupIds,
				);
			} catch (error) {
				if (!this.authority.revoked(error)) throw error;
				await tx
					.update(webhooks)
					.set({ enabled: false, lastError: "owner_authority_revoked" })
					.where(eq(webhooks.id, id));
				await this.authority.cancel(tx, id, "owner_authority_revoked");
				return;
			}
			if (!owner) return;
			this.secrets.decrypt(endpoint.secretCiphertext);
			const [backlog] = await tx
				.select({ count: sql<number>`count(*)::integer` })
				.from(deliveries)
				.where(
					and(
						eq(deliveries.webhookId, id),
						inArray(deliveries.state, ["pending", "claimed"]),
					),
				);
			let capacity = Math.max(0, 1000 - (backlog?.count ?? 1000));
			if (!capacity) {
				await tx
					.update(webhooks)
					.set({ lastError: "backlog_full" })
					.where(eq(webhooks.id, id));
				return;
			}
			const rows = await tx
				.select()
				.from(activityEvents)
				.where(gt(activityEvents.sequence, endpoint.lastSequence))
				.orderBy(asc(activityEvents.sequence))
				.limit(100);
			const now = await this.now(tx);
			let lastSequence = endpoint.lastSequence;
			for (const event of rows) {
				if (event.sequence === null) continue;
				if (
					this.authority.allowsEvent(
						owner,
						endpoint,
						event.event,
						event.groupId,
						event.global,
						event,
					)
				) {
					if (!capacity) break;
					if (Buffer.byteLength(JSON.stringify(event.payload)) > 32768)
						throw new Error("Webhook event exceeds payload limit");
					await tx
						.insert(deliveries)
						.values({
							id: Bun.randomUUIDv7(),
							webhookId: endpoint.id,
							eventId: event.id,
							groupId: event.groupId,
							requiredGroupIds: event.requiredGroupIds,
							requiresAllGroups: event.requiresAllGroups,
							global: event.global,
							endpointVersion: endpoint.version,
							url: endpoint.url,
							payload: event.payload,
							secretCiphertext: endpoint.secretCiphertext,
							signingKeyId: endpoint.signingKeyId,
							expiresAt: new Date(now.getTime() + 86400000),
							nextAttemptAt: now,
							createdAt: now,
						})
						.onConflictDoNothing();
					capacity--;
				}
				lastSequence = event.sequence;
			}
			await tx
				.update(webhooks)
				.set({ lastSequence, lastError: capacity ? null : "backlog_full" })
				.where(eq(webhooks.id, id));
		});
	}

	private async claim(id: string, webhookId: string) {
		return this.database.transaction(async (tx) => {
			const locked = await this.authority?.lock(tx, webhookId, "update");
			if (!locked || !this.authority) return;
			const { endpoint, owner } = locked;
			const [delivery] = await tx
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, id))
				.for("update", { skipLocked: true });
			if (
				!delivery ||
				(delivery.state !== "pending" && delivery.state !== "claimed")
			)
				return;
			const now = await this.now(tx);
			if (
				(delivery.state === "claimed" &&
					delivery.leaseUntil &&
					delivery.leaseUntil > now) ||
				delivery.nextAttemptAt > now
			)
				return;
			if (delivery.claimToken)
				await tx
					.update(deliveryAttempts)
					.set({
						completedAt: now,
						error: sql`case when ${deliveryAttempts.sendStartedAt} is null then 'lease_expired_before_send' else 'lease_expired_outcome_unknown' end`,
					})
					.where(
						and(
							eq(deliveryAttempts.id, delivery.claimToken),
							isNull(deliveryAttempts.completedAt),
						),
					);
			const unavailable =
				!endpoint.enabled || endpoint.version !== delivery.endpointVersion;
			const allowed =
				owner &&
				this.authority.allowsEvent(
					owner,
					endpoint,
					delivery.payload.event,
					delivery.groupId,
					delivery.global,
					delivery,
				);
			if (
				unavailable ||
				!allowed ||
				delivery.attempts >= 8 ||
				delivery.expiresAt <= now
			) {
				await tx
					.update(deliveries)
					.set({
						state: unavailable || !allowed ? "cancelled" : "failed",
						error: unavailable
							? "endpoint_unavailable"
							: !allowed
								? "authority_revoked"
								: "retry_window_exhausted",
						claimToken: null,
						leaseUntil: null,
					})
					.where(eq(deliveries.id, id));
				return;
			}
			const [active] = await tx
				.select({ id: deliveries.id })
				.from(deliveries)
				.where(
					and(
						eq(deliveries.webhookId, webhookId),
						ne(deliveries.id, id),
						eq(deliveries.state, "claimed"),
						gt(deliveries.leaseUntil, now),
					),
				)
				.limit(1);
			if (active || this.shutdown.signal.aborted) return;
			const claimToken = Bun.randomUUIDv7();
			await tx
				.update(webhooks)
				.set({ lastDispatchAt: now })
				.where(eq(webhooks.id, webhookId));
			const [claim] = await tx
				.update(deliveries)
				.set({
					state: "claimed",
					claimToken,
					leaseUntil: new Date(
						Math.min(now.getTime() + 120000, delivery.expiresAt.getTime()),
					),
				})
				.where(eq(deliveries.id, id))
				.returning();
			if (!claim) throw new Error("Webhook claim failed");
			await tx.insert(deliveryAttempts).values({
				id: claimToken,
				deliveryId: id,
				attempt: delivery.attempts + 1,
				startedAt: now,
			});
			this.metrics?.webhook("claimed");
			return claim;
		});
	}

	private async gate(tx: $Transaction, attempt: $WebhookClaim): Promise<Gate> {
		const locked = await this.authority?.lock(tx, attempt.webhookId, "share");
		if (!locked || !this.authority) return "lost";
		const [current] = await tx
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, attempt.id));
		if (
			current?.state !== "claimed" ||
			current.claimToken !== attempt.claimToken
		)
			return "lost";
		if (!current.leaseUntil || current.leaseUntil <= (await this.now(tx)))
			return "expired";
		const { endpoint, owner } = locked;
		if (!endpoint.enabled || endpoint.version !== attempt.endpointVersion)
			return "endpoint_unavailable";
		return owner &&
			this.authority.allowsEvent(
				owner,
				endpoint,
				attempt.payload.event,
				attempt.groupId,
				attempt.global,
				current,
			)
			? "ready"
			: "authority_revoked";
	}
	private async prepare(attempt: $WebhookClaim) {
		return this.database.transaction(async (tx) => {
			const timeoutSeconds = (await this.settings.read(tx))
				.webhookTimeoutSeconds;
			const gate = await this.gate(tx, attempt);
			if (gate !== "ready") return { gate };
			const checkedAt = performance.now();
			const now = await this.now(tx);
			// This commit is the uncertainty boundary. Claims alone do not consume sends.
			const [claim] = await tx
				.update(deliveries)
				.set({ attempts: sql`${deliveries.attempts} + 1`, attemptedAt: now })
				.where(
					and(
						this.fence(attempt),
						eq(deliveries.attempts, attempt.attempts),
						sql`${deliveries.attempts} < 8`,
						gt(deliveries.expiresAt, sql`clock_timestamp()`),
					),
				)
				.returning();
			if (!claim) return { gate: "expired" as const };
			const [marked] = await tx
				.update(deliveryAttempts)
				.set({ sendStartedAt: now, attempt: claim.attempts })
				.where(
					and(
						eq(deliveryAttempts.id, claim.claimToken ?? ""),
						isNull(deliveryAttempts.sendStartedAt),
						isNull(deliveryAttempts.completedAt),
					),
				)
				.returning({ id: deliveryAttempts.id });
			if (!marked) throw new Error("Webhook send marker unavailable");
			return {
				gate,
				claim,
				deadlineAt:
					checkedAt + (claim.leaseUntil?.getTime() ?? 0) - now.getTime(),
				timeoutMs: Math.floor(
					Math.min(
						timeoutSeconds * 1000,
						(claim.leaseUntil?.getTime() ?? 0) - now.getTime(),
					),
				),
			};
		});
	}
	private async send(attempt: $WebhookClaim) {
		if (!attempt.claimToken || !attempt.leaseUntil)
			throw new Error("Missing delivery lease");
		if (this.shutdown.signal.aborted) {
			await this.settle(attempt, {
				error: "shutdown_before_send",
				retry: true,
			});
			return;
		}
		const body = JSON.stringify(attempt.payload);
		const timestamp = String(Math.floor(Date.now() / 1000));
		let signature: string;
		try {
			signature = this.secrets.sign(
				attempt.secretCiphertext,
				timestamp,
				attempt.id,
				body,
			);
		} catch {
			await this.settle(attempt, {
				error: "signing_key_unavailable",
				retry: true,
			});
			return;
		}
		const prepared = await this.prepare(attempt);
		if (!prepared.claim || !prepared.timeoutMs) {
			// Lost ownership and expired leases are NEVER terminal delivery failures.
			if (
				prepared.gate === "authority_revoked" ||
				prepared.gate === "endpoint_unavailable"
			)
				await this.settle(attempt, { error: prepared.gate, cancelled: true });
			return;
		}
		const claim = prepared.claim;
		const timeoutMs = Math.floor(
			Math.min(prepared.timeoutMs, prepared.deadlineAt - performance.now()),
		);
		if (timeoutMs < 1) return;
		const cancellation = new AbortController();
		const signal = AbortSignal.any([cancellation.signal, this.shutdown.signal]);
		let interruption: Gate | "authority_check_unavailable" | undefined;
		let checking: Promise<void> | undefined;
		const timer = setInterval(() => {
			if (checking || signal.aborted) return;
			checking = this.database
				.transaction((tx) => this.gate(tx, claim), "read", Date.now() + 1000)
				.then((gate) => {
					if (gate !== "ready") {
						interruption = gate;
						cancellation.abort();
					}
				})
				.catch(() => {
					interruption = "authority_check_unavailable";
					cancellation.abort();
				})
				.finally(() => {
					checking = undefined;
				});
		}, 250);
		let outcome: Outcome;
		try {
			const response = await this.transport.send(
				claim.url,
				body,
				{
					"X-Keyzori-Delivery-Id": claim.id,
					"X-Keyzori-Event-Id": claim.eventId,
					"X-Keyzori-Timestamp": timestamp,
					"X-Keyzori-Signing-Key-Id": claim.signingKeyId,
					"X-Keyzori-Signature": `v1=${signature}`,
				},
				timeoutMs,
				signal,
			);
			const status = response.status;
			outcome = {
				status,
				error: null,
				retryAfter: response.retryAfter,
				retry:
					status === 408 || status === 425 || status === 429 || status >= 500,
			};
		} catch (error) {
			const denied = error instanceof HttpError;
			outcome = {
				error: denied ? "destination_denied" : "transport",
				retry: !denied,
			};
		} finally {
			clearInterval(timer);
			await checking;
		}
		if (interruption === "lost" || interruption === "expired") return;
		if (
			interruption === "authority_revoked" ||
			interruption === "endpoint_unavailable"
		)
			outcome = { error: interruption, cancelled: true };
		else if (interruption || this.shutdown.signal.aborted)
			outcome = {
				error: interruption ?? "shutdown_outcome_unknown",
				retry: true,
			};
		await this.settle(claim, outcome);
	}
	private fence(attempt: $WebhookClaim) {
		return and(
			eq(deliveries.id, attempt.id),
			eq(deliveries.claimToken, attempt.claimToken ?? ""),
			eq(deliveries.state, "claimed"),
			gt(deliveries.leaseUntil, sql`clock_timestamp()`),
		);
	}
	private async settle(attempt: $WebhookClaim, outcome: Outcome) {
		if (!attempt.claimToken) throw new Error("Missing claim token");
		return this.database.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(deliveries)
				.where(
					and(
						eq(deliveries.id, attempt.id),
						eq(deliveries.claimToken, attempt.claimToken ?? ""),
						eq(deliveries.state, "claimed"),
					),
				)
				.for("update");
			if (!current) return;
			const now = await this.now(tx);
			// Evaluate expiry after acquiring the row lock, not before a possible lock wait.
			if (!current.leaseUntil || current.leaseUntil <= now) return;
			const status = outcome.status ?? null;
			const succeeded = status !== null && status >= 200 && status < 300;
			const nextAttemptAt = new Date(
				now.getTime() +
					retryDelay(current.attempts, outcome.retryAfter ?? null, now),
			);
			const state = outcome.cancelled
				? "cancelled"
				: succeeded
					? "succeeded"
					: outcome.retry &&
						  current.attempts < 8 &&
						  nextAttemptAt < current.expiresAt
						? "pending"
						: "failed";
			const updated = await tx
				.update(deliveries)
				.set({
					state,
					status,
					error: outcome.error,
					nextAttemptAt,
					claimToken: null,
					leaseUntil: null,
				})
				.where(this.fence(attempt))
				.returning({ id: deliveries.id });
			if (!updated.length) return;
			await tx
				.update(deliveryAttempts)
				.set({ completedAt: now, status, error: outcome.error })
				.where(
					and(
						eq(deliveryAttempts.id, attempt.claimToken ?? ""),
						isNull(deliveryAttempts.completedAt),
					),
				);
			this.metrics?.webhook(succeeded ? "succeeded" : "failed");
		});
	}
	private async now(tx: $Transaction) {
		const [clock] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values(1)) as clock`);
		if (!clock) throw new Error("Database time unavailable");
		return clock.now;
	}
}

/** Backoff starts at 30 seconds; receiver hints and jitter remain within one hour. */
export function retryDelay(
	attempt: number,
	retryAfter: string | null,
	now: Date,
	random = Math.random(),
) {
	const base = Math.min(1800000, 30000 * 2 ** Math.max(0, attempt - 1));
	let hint = 0;
	if (retryAfter && retryAfter.length <= 128) {
		const seconds = /^\d+$/.test(retryAfter)
			? Number(retryAfter) * 1000
			: Date.parse(retryAfter) - now.getTime();
		if (Number.isFinite(seconds))
			hint = Math.max(0, Math.min(3600000, seconds));
	}
	return Math.min(
		3600000,
		Math.max(
			hint,
			Math.round(base * (0.8 + Math.max(0, Math.min(1, random)) * 0.4)),
		),
	);
}
