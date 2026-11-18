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
import { activityEvents, eventState } from "../../core/database/schema/events";
import { apiKeys } from "../../core/database/schema/apiKeys";
import {
	deliveries,
	deliveryAttempts,
} from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import { HttpError } from "../../core/http/HttpError";
import { WebhookAuthority } from "./WebhookAuthority";
import { WebhookSecrets } from "./WebhookSecrets";
import {
	readStoredDelivery,
	readStoredEvent,
	StoredEventError,
} from "./EventService";
import { AuditService } from "../audits/AuditService";
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
	| "ready"
	| "busy"
	| "lost"
	| "expired"
	| "authority_revoked"
	| "endpoint_unavailable"
	| "invalid_payload"
	| "signing_key_unavailable";
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
		private readonly audit = new AuditService(),
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
		const endpoints = await this.database.transaction(async (tx) => {
			const [checkpoint] = await tx
				.select({ sequence: eventState.sequence })
				.from(eventState)
				.where(eq(eventState.id, 1));
			if (!checkpoint) throw new HttpError("SERVICE_UNAVAILABLE");
			return tx
				.select({
					id: webhooks.id,
					version: webhooks.version,
					// Grant edits publish activity and advance the high-water mark.
					// Expiry, deletion and key rotation are also observable while idle.
					reviewOwner: sql<boolean>`${webhooks.ownerApiKeyId} is not null and not exists (
						select 1 from ${apiKeys} where ${apiKeys.id} = ${webhooks.ownerApiKeyId}
						and ${apiKeys.enabled} and ${apiKeys.secretHash} = ${webhooks.ownerCredentialHash}
						and (${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > clock_timestamp()))`,
					lastError: webhooks.lastError,
					failures: webhooks.dispatchFailures,
					deferred: sql<boolean>`coalesce(${webhooks.dispatchRetryAt} > clock_timestamp(), false)`,
					behind: sql<boolean>`${webhooks.lastSequence} < ${String(checkpoint.sequence)}::bigint`,
					due: sql<
						string | null
					>`(select ${deliveries.id} from ${deliveries} where ${deliveries.webhookId} = ${webhooks.id} and ${this.due()} order by ${deliveries.nextAttemptAt}, ${deliveries.id} limit 1)`,
				})
				.from(webhooks)
				.where(eq(webhooks.enabled, true))
				.orderBy(
					sql`${webhooks.lastDispatchAt} asc nulls first`,
					asc(webhooks.id),
				)
				.limit(101);
		});
		if (endpoints.length > 100) throw new HttpError("SERVICE_UNAVAILABLE");
		let remaining = limit;
		let sharedFailure = false;
		type Endpoint = (typeof endpoints)[number];
		let round = endpoints;
		let first = true;
		do {
			const again: Endpoint[] = [];
			await this.parallel(round, async (endpoint) => {
				const { id, version } = endpoint;
				let failure: string | undefined;
				try {
					// A healthy, caught-up endpoint takes no per-endpoint locks.
					if (
						endpoint.deferred &&
						endpoint.lastError === "dispatch_unavailable"
					)
						return;
					let inserted: string | undefined;
					if (
						first &&
						!endpoint.deferred &&
						(endpoint.behind || endpoint.reviewOwner || endpoint.lastError)
					) {
						try {
							inserted = await this.enqueue(id);
						} catch (error) {
							failure =
								error instanceof StoredEventError
									? "stored_event_inconsistent"
									: "enqueue_unavailable";
						}
					}
					// A malformed newer event cannot strand already-validated queued work.
					if (remaining > 0 && !this.shutdown.signal.aborted) {
						const candidate = first
							? (endpoint.due ?? inserted)
							: await this.nextDue(id);
						if (candidate && remaining > 0) {
							remaining--;
							const claim = await this.claim(candidate, id);
							if (claim) {
								await this.send(claim);
								again.push(endpoint);
							} else remaining++;
						}
					}
					if (first && endpoint.failures && !endpoint.deferred && !failure)
						await this.database.transaction((tx) =>
							tx
								.update(webhooks)
								.set({
									dispatchFailures: 0,
									dispatchRetryAt: null,
									lastError: sql`case when ${webhooks.lastError} = 'backlog_full' then 'backlog_full' else null end`,
								})
								.where(
									and(
										eq(webhooks.id, id),
										eq(webhooks.version, version),
										eq(webhooks.dispatchFailures, endpoint.failures),
										lte(webhooks.dispatchRetryAt, sql`clock_timestamp()`),
									),
								),
						);
				} catch {
					failure = "dispatch_unavailable";
				}
				if (failure) {
					try {
						await this.endpointError(id, version, failure);
					} catch {
						sharedFailure = true;
					}
				}
			});
			first = false;
			round = again;
		} while (
			remaining > 0 &&
			round.length &&
			!sharedFailure &&
			!this.shutdown.signal.aborted
		);
		if (sharedFailure) throw new HttpError("SERVICE_UNAVAILABLE");
	}
	private due() {
		// Stable for this discovery statement and usable as an index bound. Claim
		// and settlement still compare against a fresh DB clock under the row lock.
		return or(
			and(
				eq(deliveries.state, "pending"),
				lte(deliveries.nextAttemptAt, sql`statement_timestamp()`),
			),
			and(
				eq(deliveries.state, "claimed"),
				lte(deliveries.leaseUntil, sql`statement_timestamp()`),
			),
		);
	}
	private nextDue(id: string) {
		return this.database.transaction(async (tx) => {
			const [candidate] = await tx
				.select({ id: deliveries.id })
				.from(deliveries)
				.where(and(eq(deliveries.webhookId, id), this.due()))
				.orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id))
				.limit(1);
			return candidate?.id;
		});
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
	private endpointError(id: string, version: number, error: string) {
		return this.database.transaction((tx) =>
			tx
				.update(webhooks)
				.set({
					lastError: error,
					lastDispatchAt: sql`clock_timestamp()`,
					dispatchFailures: sql`least(6, ${webhooks.dispatchFailures} + 1)`,
					dispatchRetryAt: sql`clock_timestamp() + least(30, power(2, ${webhooks.dispatchFailures} + 1)) * interval '1 second'`,
				})
				.where(
					and(
						eq(webhooks.id, id),
						eq(webhooks.enabled, true),
						eq(webhooks.version, version),
						or(
							isNull(webhooks.dispatchRetryAt),
							lte(webhooks.dispatchRetryAt, sql`clock_timestamp()`),
						),
					),
				),
		);
	}

	private async enqueue(id: string) {
		return this.database.transaction(async (tx) => {
			const locked = await this.authority?.lock(tx, id, "update");
			if (
				!locked ||
				locked === "busy" ||
				!locked.endpoint.enabled ||
				!this.authority
			)
				return;
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
				await this.authority.disableRevoked(tx, endpoint, this.audit);
				return;
			}
			if (!owner) return;
			const window = await tx
				.select({ sequence: activityEvents.sequence })
				.from(activityEvents)
				.where(gt(activityEvents.sequence, endpoint.lastSequence))
				.orderBy(asc(activityEvents.sequence))
				.limit(100);
			const high = window.at(-1)?.sequence;
			if (high == null && endpoint.lastError !== "backlog_full") return;
			const [backlog] = await tx
				.select({ count: sql<number>`count(*)::integer` })
				.from(deliveries)
				.where(
					and(
						eq(deliveries.webhookId, id),
						inArray(deliveries.state, ["pending", "claimed"]),
					),
				);
			const capacity = Math.max(0, 1000 - (backlog?.count ?? 1000));
			if (!capacity) {
				if (endpoint.lastError !== "backlog_full")
					await tx
						.update(webhooks)
						.set({ lastError: "backlog_full" })
						.where(eq(webhooks.id, id));
				return;
			}
			if (high == null) {
				await tx
					.update(webhooks)
					.set({ lastError: null })
					.where(eq(webhooks.id, id));
				return;
			}
			const rows = await tx
				.select()
				.from(activityEvents)
				.where(
					and(
						gt(activityEvents.sequence, endpoint.lastSequence),
						lte(activityEvents.sequence, high),
						this.authority.enqueueFilter(owner, endpoint),
					),
				)
				.orderBy(asc(activityEvents.sequence))
				.limit(Math.min(capacity + 1, 100));
			const batch = rows.slice(0, capacity);
			const overflow = rows[capacity]?.sequence;
			// Only pass contiguous classified positions, never the first unqueued match.
			const lastSequence = overflow == null ? high : overflow - 1n;
			const now = await this.now(tx);
			let inserted: { id: string }[] = [];
			if (batch.length) {
				this.secrets.decrypt(endpoint.secretCiphertext);
				inserted = await tx
					.insert(deliveries)
					.values(
						batch.map((event) => ({
							id: Bun.randomUUIDv7(),
							webhookId: endpoint.id,
							eventId: event.id,
							groupId: event.groupId,
							requiredGroupIds: event.requiredGroupIds,
							requiresAllGroups: event.requiresAllGroups,
							global: event.global,
							endpointVersion: endpoint.version,
							url: endpoint.url,
							payload: readStoredEvent(event),
							secretCiphertext: endpoint.secretCiphertext,
							signingKeyId: endpoint.signingKeyId,
							expiresAt: new Date(now.getTime() + 86400000),
							nextAttemptAt: now,
							createdAt: now,
						})),
					)
					.onConflictDoNothing({
						target: [deliveries.webhookId, deliveries.eventId],
						where: isNull(deliveries.replayOf),
					})
					.returning({ id: deliveries.id });
			}
			await tx
				.update(webhooks)
				.set({
					lastSequence,
					lastError: inserted.length === capacity ? "backlog_full" : null,
				})
				.where(eq(webhooks.id, id));
			return inserted[0]?.id;
		});
	}

	private async claim(id: string, webhookId: string) {
		const claimed = await this.database.transaction(async (tx) => {
			const locked = await this.authority?.lock(tx, webhookId, "update");
			if (!locked || locked === "busy" || !this.authority) return;
			const [delivery] = await tx
				.select()
				.from(deliveries)
				.where(and(eq(deliveries.id, id), eq(deliveries.webhookId, webhookId)))
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
			const check = this.checkDelivery(locked, delivery, now);
			if (
				check !== "ready" ||
				delivery.attempts >= 8 ||
				delivery.expiresAt <= now
			) {
				await tx
					.update(deliveries)
					.set({
						state:
							check === "endpoint_unavailable" || check === "authority_revoked"
								? "cancelled"
								: "failed",
						error: check === "ready" ? "retry_window_exhausted" : check,
						claimToken: null,
						leaseUntil: null,
						terminalAt: now,
						secretCiphertext: null,
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
			return claim;
		});
		if (claimed) this.metrics?.webhook("claimed");
		return claimed;
	}

	private checkDelivery(
		locked: Exclude<
			Awaited<ReturnType<WebhookAuthority["lock"]>>,
			"busy" | undefined
		>,
		current: $WebhookClaim,
		now: Date,
	): Gate {
		const { endpoint, owner } = locked;
		if (
			!endpoint.enabled ||
			endpoint.version !== current.endpointVersion ||
			endpoint.id !== current.webhookId ||
			endpoint.url !== current.url
		)
			return "endpoint_unavailable";
		let payload;
		try {
			payload = readStoredDelivery(current);
		} catch (error) {
			if (error instanceof StoredEventError) return "invalid_payload";
			throw error;
		}
		if (
			!owner ||
			!this.authority ||
			(owner.kind === "api" && owner.expiresAt && owner.expiresAt <= now)
		)
			return "authority_revoked";
		try {
			this.authority.selection(
				owner,
				endpoint.events,
				endpoint.allGroups,
				endpoint.groupIds,
			);
		} catch (error) {
			if (this.authority.revoked(error)) return "authority_revoked";
			throw error;
		}
		return this.authority.allowsEvent(
			owner,
			endpoint,
			payload.event,
			current.groupId,
			current.global,
			current,
		)
			? "ready"
			: "authority_revoked";
	}

	private async gate(
		tx: $Transaction,
		attempt: $WebhookClaim,
		preparing = false,
	): Promise<Exclude<Gate, "ready"> | $WebhookClaim> {
		const locked = await this.authority?.lock(tx, attempt.webhookId, "share");
		if (locked === "busy") return "busy";
		if (!locked) return "lost";
		const query = tx
			.select()
			.from(deliveries)
			.where(eq(deliveries.id, attempt.id));
		const [current] = preparing ? await query.for("update") : await query;
		if (
			current?.state !== "claimed" ||
			current.claimToken !== attempt.claimToken
		)
			return "lost";
		const now = await this.now(tx);
		if (!current.leaseUntil || current.leaseUntil <= now) return "expired";
		const check = this.checkDelivery(locked, current, now);
		return check === "ready" ? current : check;
	}
	private async prepare(attempt: $WebhookClaim) {
		return this.database.transaction(
			async (tx) => {
				const timeoutSeconds = (await this.settings.read(tx))
					.webhookTimeoutSeconds;
				const verified = await this.gate(tx, attempt, true);
				if (typeof verified === "string") return { gate: verified };
				const checkedAt = performance.now();
				const now = await this.now(tx);
				// Authorize, validate and sign the same locked database snapshot. Avoid
				// using the caller's earlier copy of the JSON, destination or key.
				const body = JSON.stringify(verified.payload);
				const timestamp = String(Math.floor(now.getTime() / 1000));
				let signature: string;
				try {
					if (!verified.secretCiphertext)
						return { gate: "signing_key_unavailable" as const };
					signature = this.secrets.sign(
						verified.secretCiphertext,
						timestamp,
						verified.id,
						body,
					);
				} catch {
					return { gate: "signing_key_unavailable" as const };
				}
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
					gate: "ready" as const,
					claim,
					body,
					timestamp,
					signature,
					deadlineAt:
						checkedAt + (claim.leaseUntil?.getTime() ?? 0) - now.getTime(),
					timeoutMs: Math.floor(
						Math.min(
							timeoutSeconds * 1000,
							(claim.leaseUntil?.getTime() ?? 0) - now.getTime(),
						),
					),
				};
			},
			"read",
			Date.now() + 2000,
		);
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
		let prepared: Awaited<ReturnType<WebhookDispatcher["prepare"]>>;
		try {
			prepared = await this.prepare(attempt);
		} catch (error) {
			if (!(error instanceof HttpError && error.code === "SERVICE_UNAVAILABLE"))
				throw error;
			await this.settle(attempt, {
				error: "authority_check_unavailable_before_send",
				retry: true,
			});
			return;
		}
		if (!prepared.claim || !prepared.timeoutMs) {
			// Lost ownership and expired leases are NEVER terminal delivery failures.
			if (
				prepared.gate === "authority_revoked" ||
				prepared.gate === "endpoint_unavailable"
			)
				await this.settle(attempt, { error: prepared.gate, cancelled: true });
			else if (prepared.gate === "invalid_payload")
				await this.settle(attempt, { error: prepared.gate });
			else if (
				prepared.gate === "busy" ||
				prepared.gate === "signing_key_unavailable"
			)
				await this.settle(attempt, { error: prepared.gate, retry: true });
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
					if (typeof gate === "string") {
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
				prepared.body,
				{
					"X-Keyzori-Delivery-Id": claim.id,
					"X-Keyzori-Event-Id": claim.eventId,
					"X-Keyzori-Timestamp": prepared.timestamp,
					"X-Keyzori-Signing-Key-Id": claim.signingKeyId,
					"X-Keyzori-Signature": `v1=${prepared.signature}`,
				},
				timeoutMs,
				signal,
				claim.attempts,
			);
			const status = response.status;
			outcome = {
				status,
				error: null,
				retryAfter: response.retryAfter,
				retry:
					status === 408 ||
					status === 425 ||
					status === 429 ||
					(status >= 500 && status < 600),
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
		else if (interruption === "invalid_payload")
			outcome = { error: interruption };
		else if (interruption || this.shutdown.signal.aborted)
			outcome = {
				error: interruption
					? `${interruption}_outcome_unknown`
					: "shutdown_outcome_unknown",
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
		const result = await this.database.transaction(async (tx) => {
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
					terminalAt: state === "pending" ? null : now,
					secretCiphertext:
						state === "pending" ? current.secretCiphertext : null,
				})
				.where(this.fence(attempt))
				.returning({ id: deliveries.id });
			if (!updated.length) return;
			const [completed] = await tx
				.update(deliveryAttempts)
				.set({ completedAt: now, status, error: outcome.error })
				.where(
					and(
						eq(deliveryAttempts.id, attempt.claimToken ?? ""),
						isNull(deliveryAttempts.completedAt),
					),
				)
				.returning({ sendStartedAt: deliveryAttempts.sendStartedAt });
			if (completed?.sendStartedAt)
				return succeeded ? ("succeeded" as const) : ("failed" as const);
		});
		if (result) this.metrics?.webhook(result);
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
