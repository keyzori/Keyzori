import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const licenseConfig = type({ type: "'lifetime'", "+": "reject" })
	.describe("No time-based expiry.")
	.or({
		type: "'subscription'",
		expiresAt: type("string.date.iso").describe(
			"Future ISO 8601 subscription expiry.",
		),
		"+": "reject",
	})
	.or({
		type: type("'trial'").describe(
			"License model: lifetime, subscription, trial, or metered.",
		),
		durationSeconds: type("1 <= number.integer <= 31536000").describe(
			"Trial duration in seconds, measured from first successful activation.",
		),
		"+": "reject",
	})
	.or({ type: "'metered'", "+": "reject" });
export const licenseBody = type({
	customerId: type("string.uuid").describe(
		"UUID of the customer that owns the license.",
	),
	config: licenseConfig.describe(
		"Complete configuration for the selected license type.",
	),
	"metadata?": metadataSchema.describe(
		"Custom JSON object. At most 8,192 serialized characters; sensitive values are redacted.",
	),
	"+": "reject",
});
export const licenseUpdate = type({
	"customerId?": type("string.uuid").describe(
		"UUID of the customer that owns the license.",
	),
	"metadata?": metadataSchema.describe(
		"Custom JSON object. At most 8,192 serialized characters; sensitive values are redacted.",
	),
	"+": "reject",
});
export const renewalBody = type({
	expiresAt: type("string.date.iso").describe(
		"ISO 8601 expiry timestamp. New subscription expiries must be in the future.",
	),
	"+": "reject",
});
export const licenseQuery = type({
	"customerId?": type("string.uuid").describe(
		"UUID of the customer that owns the license.",
	),
	"type?": type("'lifetime' | 'subscription' | 'trial' | 'metered'").describe(
		"License model: lifetime, subscription, trial, or metered.",
	),
	"limit?": type("string.digits").describe("Page size, 1–100. Defaults to 50."),
	"offset?": type("string.digits").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	"+": "reject",
});
