import Stripe from "stripe";
import type { StripeConfig } from "./StripeConfig.ts";
import { AppError } from "../../src/shared/errors.ts";
import { webhookEvent } from "./schemas.ts";

export type BillingState = {
	subscriptionId: string;
	customerId: string;
	status: string;
	expiresAt: Date | null;
};
export class StripeGateway {
	private readonly client;
	constructor(private readonly config: StripeConfig) {
		this.client = new Stripe(config.secretKey, {
			timeout: 5000,
			maxNetworkRetries: 1,
		});
	}
	async verify(raw: Uint8Array, signature: string) {
		try {
			const event = await this.client.webhooks.constructEventAsync(
				Buffer.from(raw),
				signature,
				this.config.webhookSecret,
			);
			if (!webhookEvent.allows(event))
				throw new AppError(
					"WEBHOOK_PAYLOAD",
					"Webhook payload is invalid.",
					400,
				);
			return event;
		} catch (error) {
			if (error instanceof AppError) throw error;
			throw new AppError(
				"WEBHOOK_SIGNATURE",
				"Webhook signature is invalid.",
				400,
			);
		}
	}
	async subscription(id: string): Promise<BillingState> {
		try {
			const subscription = await this.client.subscriptions.retrieve(id);
			const ends = subscription.items.data
				.map((item) => item.current_period_end)
				.filter((end) => Number.isFinite(end) && end > 0);
			return {
				subscriptionId: id,
				customerId:
					typeof subscription.customer === "string"
						? subscription.customer
						: subscription.customer.id,
				status: subscription.status,
				expiresAt: ends.length ? new Date(Math.min(...ends) * 1000) : null,
			};
		} catch (error) {
			if (
				error instanceof Stripe.errors.StripeInvalidRequestError &&
				error.code === "resource_missing"
			)
				return {
					subscriptionId: id,
					customerId: "",
					status: "missing",
					expiresAt: null,
				};
			throw new AppError(
				"BILLING_UNAVAILABLE",
				"Billing provider is unavailable.",
				503,
			);
		}
	}
	subscriptionId(event: Stripe.Event): string | null {
		const value: unknown = event.data.object;
		if (!value || typeof value !== "object") return null;
		if (
			event.type.startsWith("customer.subscription.") &&
			"id" in value &&
			typeof value.id === "string"
		)
			return value.id;
		if (event.type.startsWith("invoice.") && "parent" in value) {
			const invoice = value as Stripe.Invoice;
			const subscription = invoice.parent?.subscription_details?.subscription;
			return typeof subscription === "string"
				? subscription
				: (subscription?.id ?? null);
		}
		return null;
	}
}
