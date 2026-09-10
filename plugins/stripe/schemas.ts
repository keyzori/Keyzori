import { type } from "arktype";

export const linkBody = type({
	licenseId: "string.uuid",
	subscriptionId: /^sub_[A-Za-z0-9]+$/,
	"+": "reject",
});
export const eventQuery = type({
	"state?": "'pending' | 'processing' | 'completed'",
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
export const webhookHeaders = type({
	"stripe-signature": "1 <= string <= 4096",
});

export const webhookEvent = type({
	id: /^evt_[A-Za-z0-9]+$/,
	type: "1 <= string <= 256",
	data: { object: "object" },
});
