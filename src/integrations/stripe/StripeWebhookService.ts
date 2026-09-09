import type { Stripe } from "stripe";
import type { JsonObject, StripeWebhookEvent } from "../../domain/entities";
import type { IStripeWebhookRepository } from "../../domain/repositories/IStripeRepository";
import {
	type ActivityRecorder,
	noopActivityRecorder,
} from "../../application/services/ActivityService";
import type { StripeGatewayPort } from "./StripeGateway";
import type { StripeSubscriptionService } from "./StripeSubscriptionService";

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function expandableId(value: unknown): string | null {
	if (typeof value === "string") return value;
	const object = objectValue(value);
	return typeof object?.id === "string" ? object.id : null;
}

/** Supports both the Dahlia invoice parent and older retained invoice payloads. */
export function subscriptionIdFromStripeEvent(
	event: Stripe.Event | JsonObject,
): string | null {
	const root = objectValue(event);
	const data = objectValue(root?.data);
	const eventObject = objectValue(data?.object);
	if (!eventObject) return null;
	if (eventObject.object === "subscription") {
		return expandableId(eventObject);
	}
	if (eventObject.object !== "invoice") return null;
	const parent = objectValue(eventObject.parent);
	const subscriptionDetails = objectValue(parent?.subscription_details);
	return (
		expandableId(subscriptionDetails?.subscription) ??
		expandableId(eventObject.subscription)
	);
}

function persistedEvent(event: Stripe.Event): JsonObject {
	const serialized = JSON.parse(JSON.stringify(event)) as unknown;
	const object = objectValue(serialized);
	if (!object) throw new Error("Stripe webhook event is not a JSON object.");
	return object as JsonObject;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		1_000,
	);
}

export interface StripeWebhookReceipt {
	eventId: string;
	type: string;
	subscriptionId: string | null;
	inserted: boolean;
}

export interface StripeWebhookBatchResult {
	claimed: number;
	processed: number;
	failed: number;
}

export interface StripeWebhookRetryOptions {
	baseDelayMs?: number;
	maxDelayMs?: number;
}

/** Signature verification, durable enqueueing, and current-state processing. */
export class StripeWebhookService {
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;

	constructor(
		private readonly gateway: StripeGatewayPort,
		private readonly events: IStripeWebhookRepository,
		private readonly subscriptions: StripeSubscriptionService,
		private readonly activity: ActivityRecorder = noopActivityRecorder,
		retry: StripeWebhookRetryOptions = {},
	) {
		this.baseDelayMs = Math.max(100, retry.baseDelayMs ?? 1_000);
		this.maxDelayMs = Math.max(
			this.baseDelayMs,
			retry.maxDelayMs ?? 5 * 60_000,
		);
	}

	async receive(
		rawPayload: string | Uint8Array,
		signature: string,
	): Promise<StripeWebhookReceipt> {
		const event = await this.gateway.verifyWebhook(rawPayload, signature);
		const subscriptionId = subscriptionIdFromStripeEvent(event);
		const result = await this.events.enqueue({
			eventId: event.id,
			type: event.type,
			objectId: subscriptionId,
			payload: persistedEvent(event),
		});
		return {
			eventId: event.id,
			type: event.type,
			subscriptionId,
			inserted: result.inserted,
		};
	}

	async processDue(
		limit = 10,
		now = new Date(),
	): Promise<StripeWebhookBatchResult> {
		const claimed = await this.events.claimDue(limit, now);
		let processed = 0;
		let failed = 0;
		for (const event of claimed) {
			const succeeded = await this.processOne(event, now);
			if (succeeded) processed += 1;
			else failed += 1;
		}
		return { claimed: claimed.length, processed, failed };
	}

	private async processOne(
		event: StripeWebhookEvent,
		now: Date,
	): Promise<boolean> {
		const subscriptionId =
			event.objectId ?? subscriptionIdFromStripeEvent(event.payload);
		try {
			if (subscriptionId) {
				await this.subscriptions.reconcileSubscription(subscriptionId, now);
			}
			await this.events.markProcessed(event.eventId, now);
			return true;
		} catch (error) {
			const message = errorMessage(error);
			if (subscriptionId) {
				await this.subscriptions
					.recordReconciliationFailure(subscriptionId, message)
					.catch(() => undefined);
			}
			const exponent = Math.min(Math.max(event.attempts - 1, 0), 30);
			const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
			await this.events.markFailed(
				event.eventId,
				message,
				new Date(now.getTime() + delay),
			);
			await this.activity.capture({
				type: "stripe.webhook_failed",
				source: "stripe",
				outcome: "error",
				reason: "reconciliation_failed",
				details: {
					eventId: event.eventId,
					eventType: event.type,
					subscriptionId,
					attempt: event.attempts,
					error: message,
				},
			});
			return false;
		}
	}
}

export interface StripeWebhookWorkerOptions {
	intervalMs?: number;
	batchSize?: number;
}

/** Polling is intentional: inbox rows survive process restarts and failed wakeups. */
export class StripeWebhookWorker {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly intervalMs: number;
	private readonly batchSize: number;

	constructor(
		private readonly service: StripeWebhookService,
		options: StripeWebhookWorkerOptions = {},
	) {
		this.intervalMs = Math.max(250, options.intervalMs ?? 1_000);
		this.batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 100));
	}

	start(): () => void {
		if (this.timer) return () => this.stop();
		this.timer = setInterval(() => this.wake(), this.intervalMs);
		this.timer.unref?.();
		this.wake();
		return () => this.stop();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async runOnce(): Promise<StripeWebhookBatchResult> {
		if (this.running) return { claimed: 0, processed: 0, failed: 0 };
		this.running = true;
		try {
			return await this.service.processDue(this.batchSize);
		} finally {
			this.running = false;
		}
	}

	private wake(): void {
		void this.runOnce().catch((error) => {
			console.error("Stripe webhook worker failed", error);
		});
	}
}
