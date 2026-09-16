import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const heartbeatResponse = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	type: type("'lifetime' | 'subscription' | 'metered' | 'trial'").describe(
		"License model: lifetime, subscription, trial, or metered.",
	),
	expiresIn: type("number.integer").describe(
		"Session lifetime in seconds. Send a heartbeat before this interval elapses.",
	),
});
export const activationResponse = heartbeatResponse
	.and(
		type({
			token: type(/^ses_[A-Za-z0-9_-]{43}$/).describe(
				"Secret bearer token for this device-bound session. Store securely.",
			),
			metadata: metadataSchema,
		}),
	)
	.onUndeclaredKey("reject");
export const deactivationResponse = type({
	deactivated: type("boolean").describe("Whether this session was released."),
});
export const sessionResponse = type({
	id: type("string").describe(
		"SHA-256 session identifier for admin termination; not a bearer token.",
	),
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	revision: type("number.integer").describe(
		"License policy revision recorded when this session was activated.",
	),
	ttl: type("number.integer").describe(
		"Remaining Redis session lifetime in seconds.",
	),
	"+": "reject",
});
