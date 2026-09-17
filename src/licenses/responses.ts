import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";
import { timestamp } from "../shared/responses.ts";

const subscription = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	expiresAt: timestamp.describe(
		"ISO 8601 expiry timestamp. New subscription expiries must be in the future.",
	),
}).or("null");
const trial = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	durationSeconds: type("number.integer").describe(
		"Trial duration in seconds, measured from first successful activation.",
	),
	activatedAt: timestamp
		.or("null")
		.describe(
			"First successful trial activation time, or null before activation.",
		),
	expiresAt: timestamp
		.or("null")
		.describe(
			"ISO 8601 expiry timestamp. New subscription expiries must be in the future.",
		),
}).or("null");
export const blockResponse = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	source: type("string").describe(
		"Source of the action or access block, such as core, manual, or a plugin name.",
	),
	reason: type("string").describe(
		"Human-readable access-block reason. Sensitive values are redacted.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
});
const licenseResource = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	customerId: type("string.uuid").describe(
		"UUID of the customer that owns the license.",
	),
	type: type("'lifetime' | 'subscription' | 'metered' | 'trial'").describe(
		"License model: lifetime, subscription, trial, or metered.",
	),
	policyRevision: type("number.integer").describe(
		"Current license policy revision. A change invalidates sessions using an older revision.",
	),
	maxDevices: type("number.integer").describe(
		"Maximum registered devices, including blocked registrations. Default 1; allowed range 1–10,000.",
	),
	maxIps: type("number.integer").describe(
		"Maximum registered IP addresses, including blocked registrations. Default 1; allowed range 1–10,000.",
	),
	maxSessions: type("number.integer").describe(
		"Maximum concurrent active sessions. Default 1; allowed range 1–10,000.",
	),
	deviceAllowlistEnabled: type("boolean").describe(
		"Whether activation requires a device present in the device allowlist.",
	),
	ipAllowlistEnabled: type("boolean").describe(
		"Whether activation requires an IP matching the network allowlist.",
	),
	metadata: metadataSchema.describe(
		"Custom JSON object. At most 8,192 serialized characters; sensitive values are redacted.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
	updatedAt: timestamp.describe(
		"ISO 8601 timestamp of the most recent update.",
	),
	"subscription?": subscription.describe(
		"Subscription configuration, when applicable.",
	),
	"trial?": trial.describe("Trial configuration, when applicable."),
	"blocks?": blockResponse
		.array()
		.describe(
			"Active access blocks. Every source must be cleared before access is restored.",
		),
});
export const licenseResponse = licenseResource.onUndeclaredKey("reject");
export const createdLicenseResponse = licenseResource
	.and(
		type({
			key: type(/^lic_[A-Za-z0-9_-]{43}$/).describe(
				"New secret license key, shown only in this response. Store securely.",
			),
		}),
	)
	.onUndeclaredKey("reject");
