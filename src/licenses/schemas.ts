import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const licenseConfig = type({ type: "'lifetime'", "+": "reject" })
	.or({ type: "'subscription'", expiresAt: "string.date.iso", "+": "reject" })
	.or({
		type: "'trial'",
		durationSeconds: "1 <= number.integer <= 31536000",
		"+": "reject",
	})
	.or({ type: "'metered'", "+": "reject" });
export const licenseBody = type({
	customerId: "string.uuid",
	config: licenseConfig,
	"metadata?": metadataSchema,
	"+": "reject",
});
export const licenseUpdate = type({
	"customerId?": "string.uuid",
	"metadata?": metadataSchema,
	"+": "reject",
});
export const renewalBody = type({
	expiresAt: "string.date.iso",
	"+": "reject",
});
export const licenseQuery = type({
	"customerId?": "string.uuid",
	"type?": "'lifetime' | 'subscription' | 'trial' | 'metered'",
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
