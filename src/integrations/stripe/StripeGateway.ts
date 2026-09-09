import { Stripe } from "stripe";
import type { StripeConfig } from "../../config";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export interface StripeSubscriptionSnapshot {
	subscriptionId: string;
	stripeCustomerId: string;
	status: Stripe.Subscription.Status;
	paidThrough: Date | null;
	cancelAtPeriodEnd: boolean;
	priceIds: string[];
	billingBlocked: boolean;
}

export interface StripeGatewayPort {
	verifyWebhook(
		payload: string | Uint8Array,
		signature: string,
	): Promise<Stripe.Event>;
	getSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot>;
}

export class StripeWebhookSignatureError extends Error {
	constructor(
		message = "Invalid Stripe webhook signature.",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StripeWebhookSignatureError";
	}
}

function expandableId(value: string | { id: string } | null): string | null {
	if (!value) return null;
	return typeof value === "string" ? value : value.id;
}

export function summarizeSubscription(
	subscription: Stripe.Subscription,
	now = new Date(),
): StripeSubscriptionSnapshot {
	const periodEnds = subscription.items.data
		.map((item) => item.current_period_end)
		.filter((value): value is number => Number.isFinite(value));
	const paidThroughSeconds =
		periodEnds.length > 0 ? Math.min(...periodEnds) : null;
	const paidThrough = paidThroughSeconds
		? new Date(paidThroughSeconds * 1_000)
		: null;
	const terminal = new Set<Stripe.Subscription.Status>([
		"canceled",
		"incomplete_expired",
		"paused",
		"unpaid",
	]);
	const statusAllowsAccess =
		subscription.status === "active" ||
		subscription.status === "trialing" ||
		subscription.status === "past_due";
	const periodAllowsAccess = paidThrough !== null && paidThrough > now;
	const stripeCustomerId = expandableId(subscription.customer);
	if (!stripeCustomerId)
		throw new Error("Stripe subscription has no customer ID.");

	return {
		subscriptionId: subscription.id,
		stripeCustomerId,
		status: subscription.status,
		paidThrough,
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		priceIds: [
			...new Set(
				subscription.items.data
					.map((item) => expandableId(item.price))
					.filter((value): value is string => value !== null),
			),
		],
		billingBlocked:
			terminal.has(subscription.status) ||
			!statusAllowsAccess ||
			!periodAllowsAccess,
	};
}

export class StripeGateway implements StripeGatewayPort {
	readonly client: Stripe;

	constructor(private readonly config: StripeConfig) {
		this.client = new Stripe(config.secretKey, {
			apiVersion: STRIPE_API_VERSION,
			maxNetworkRetries: 2,
			timeout: 10_000,
		});
	}

	async verifyWebhook(
		payload: string | Uint8Array,
		signature: string,
	): Promise<Stripe.Event> {
		try {
			return await this.client.webhooks.constructEventAsync(
				payload,
				signature,
				this.config.webhookSecret,
			);
		} catch (error) {
			throw new StripeWebhookSignatureError(undefined, { cause: error });
		}
	}

	async getSubscription(
		subscriptionId: string,
	): Promise<StripeSubscriptionSnapshot> {
		const subscription = await this.client.subscriptions.retrieve(
			subscriptionId,
			{ expand: ["items.data.price"] },
		);
		return summarizeSubscription(subscription);
	}
}
