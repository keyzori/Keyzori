import { describe, expect, test } from "bun:test";
import type { Stripe } from "stripe";
import {
	StripeGateway,
	StripeWebhookSignatureError,
	summarizeSubscription,
} from "./StripeGateway";

function subscription(
	status: Stripe.Subscription.Status,
	periodEnd: number,
	cancelAtPeriodEnd = false,
): Stripe.Subscription {
	return {
		id: "sub_current",
		object: "subscription",
		customer: "cus_current",
		status,
		cancel_at_period_end: cancelAtPeriodEnd,
		items: {
			object: "list",
			data: [
				{
					id: "si_current",
					object: "subscription_item",
					current_period_end: periodEnd,
					price: { id: "price_current" } as Stripe.Price,
				} as Stripe.SubscriptionItem,
			],
			has_more: false,
			url: "/v1/subscription_items",
		},
	} as Stripe.Subscription;
}

describe("StripeGateway", () => {
	test("verifies the exact signed payload and rejects a changed body", async () => {
		const webhookSecret = "whsec_test_secret";
		const gateway = new StripeGateway({
			secretKey: "sk_test_fake",
			webhookSecret,
		});
		const payload =
			'{ "id": "evt_signed", "object": "event", "type": "customer.subscription.updated", "data": { "object": { "id": "sub_current", "object": "subscription" } } }';
		const signature =
			await gateway.client.webhooks.generateTestHeaderStringAsync({
				payload,
				secret: webhookSecret,
			});

		const event = await gateway.verifyWebhook(
			new TextEncoder().encode(payload),
			signature,
		);
		expect(event.id).toBe("evt_signed");
		expect(
			gateway.verifyWebhook(`${payload} `, signature),
		).rejects.toBeInstanceOf(StripeWebhookSignatureError);
	});

	test("implements paid-through and terminal access rules", () => {
		const now = new Date("2026-08-15T00:00:00.000Z");
		const future = Math.floor(now.getTime() / 1_000) + 3_600;
		const past = Math.floor(now.getTime() / 1_000) - 1;
		expect(
			summarizeSubscription(subscription("active", future), now)
				.stripeCustomerId,
		).toBe("cus_current");
		for (const status of ["active", "trialing", "past_due"] as const) {
			expect(
				summarizeSubscription(subscription(status, future), now).billingBlocked,
			).toBe(false);
		}
		expect(
			summarizeSubscription(subscription("active", future, true), now)
				.billingBlocked,
		).toBe(false);
		expect(
			summarizeSubscription(subscription("past_due", past), now).billingBlocked,
		).toBe(true);
		for (const status of [
			"canceled",
			"unpaid",
			"incomplete_expired",
			"paused",
		] as const) {
			expect(
				summarizeSubscription(subscription(status, future), now).billingBlocked,
			).toBe(true);
		}
	});
});
