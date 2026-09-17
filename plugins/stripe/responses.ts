import { type } from "arktype";
import { timestamp, pageResponse } from "../../src/shared/responses.ts";

export const linkResponse = type({
	id: type("string.uuid").describe("Internal Keyzori record UUID."),
	licenseId: type("string.uuid").describe(
		"UUID of the Keyzori subscription license.",
	),
	subscriptionId: type("string").describe(
		"Existing Stripe subscription ID, beginning with sub_.",
	),
	customerId: type("string").describe(
		"Stripe customer ID associated with the subscription; not a Keyzori customer UUID.",
	),
	status: type("string").describe(
		"Most recently synchronized Stripe subscription status.",
	),
	syncedAt: timestamp.describe(
		"ISO 8601 time of the last billing synchronization.",
	),
	"+": "reject",
});
export const linksResponse = pageResponse(linkResponse);
export const eventResponse = type({
	id: type("string.uuid").describe("Internal Keyzori record UUID."),
	eventId: type("string").describe(
		"Original Stripe event identifier, beginning with evt_.",
	),
	eventType: type("string").describe(
		"Stripe event type received by the webhook.",
	),
	subscriptionId: type("string | null").describe(
		"Existing Stripe subscription ID, beginning with sub_.",
	),
	state: type("string").describe(
		"Webhook processing state: pending, processing, or completed.",
	),
	attempts: type("number.integer").describe(
		"Number of processing attempts made.",
	),
	nextAttemptAt: timestamp.describe(
		"ISO 8601 time when another processing attempt becomes eligible.",
	),
	createdAt: timestamp.describe("ISO 8601 time when the event was stored."),
	completedAt: timestamp
		.or("null")
		.describe("ISO 8601 completion time, or null while incomplete."),
	"+": "reject",
});
export const eventsResponse = pageResponse(eventResponse);
export const retryResponse = type({ id: "string.uuid", state: "string" });
export const receivedResponse = type({ received: "boolean" });
