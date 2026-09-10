import { type } from "arktype";
import { timestamp, pageResponse } from "../../src/shared/responses.ts";

export const linkResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid",
	subscriptionId: "string",
	customerId: "string",
	status: "string",
	syncedAt: timestamp,
	"+": "reject",
});
export const linksResponse = pageResponse(linkResponse);
export const eventResponse = type({
	id: "string.uuid",
	eventId: "string",
	eventType: "string",
	subscriptionId: "string | null",
	state: "string",
	attempts: "number.integer",
	nextAttemptAt: timestamp,
	createdAt: timestamp,
	completedAt: timestamp.or("null"),
	"+": "reject",
});
export const eventsResponse = pageResponse(eventResponse);
export const retryResponse = type({ id: "string.uuid", state: "string" });
export const receivedResponse = type({ received: "boolean" });
