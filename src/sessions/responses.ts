import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const heartbeatResponse = type({
	licenseId: "string.uuid",
	type: "'lifetime' | 'subscription' | 'metered' | 'trial'",
	expiresIn: "number.integer",
});
export const activationResponse = heartbeatResponse
	.and(type({ token: /^ses_[A-Za-z0-9_-]{43}$/, metadata: metadataSchema }))
	.onUndeclaredKey("reject");
export const deactivationResponse = type({ deactivated: "boolean" });
export const sessionResponse = type({
	id: "string",
	licenseId: "string.uuid",
	revision: "number.integer",
	ttl: "number.integer",
	"+": "reject",
});
