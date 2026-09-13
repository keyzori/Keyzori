import { type } from "arktype";

export const linkBody = type({
	licenseId: type("string.uuid").describe(
		"UUID of the Keyzori subscription license.",
	),
	subscriptionId: type(/^sub_[A-Za-z0-9]+$/).describe(
		"Existing Stripe subscription ID, beginning with sub_.",
	),
	"+": "reject",
});
export const eventQuery = type({
	"state?": type("'pending' | 'processing' | 'completed'").describe(
		"Webhook processing state: pending, processing, or completed.",
	),
	"limit?": type("string.digits").describe("Page size, 1–100; default 50."),
	"offset?": type("string.digits").describe(
		"Records to skip, 0–1,000,000; default 0.",
	),
	"+": "reject",
});
export const webhookHeaders = type({
	"stripe-signature": type("1 <= string <= 4096").describe(
		"Stripe signature for the unmodified request bytes. Required for webhook verification.",
	),
});

export const webhookEvent = type({
	id: type(/^evt_[A-Za-z0-9]+$/).describe("Internal Keyzori record UUID."),
	type: "1 <= string <= 256",
	data: { object: "object" },
});
