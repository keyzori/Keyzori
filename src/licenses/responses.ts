import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";
import { timestamp } from "../shared/responses.ts";

const subscription = type({
	licenseId: "string.uuid",
	expiresAt: timestamp,
}).or("null");
const trial = type({
	licenseId: "string.uuid",
	durationSeconds: "number.integer",
	activatedAt: timestamp.or("null"),
	expiresAt: timestamp.or("null"),
}).or("null");
export const blockResponse = type({
	licenseId: "string.uuid",
	source: "string",
	reason: "string",
	createdAt: timestamp,
});
const licenseResource = type({
	id: "string.uuid",
	customerId: "string.uuid",
	type: "'lifetime' | 'subscription' | 'metered' | 'trial'",
	policyRevision: "number.integer",
	maxDevices: "number.integer",
	maxIps: "number.integer",
	maxSessions: "number.integer",
	deviceAllowlistEnabled: "boolean",
	ipAllowlistEnabled: "boolean",
	metadata: metadataSchema,
	createdAt: timestamp,
	updatedAt: timestamp,
	"subscription?": subscription,
	"trial?": trial,
	"blocks?": blockResponse.array(),
});
export const licenseResponse = licenseResource.onUndeclaredKey("reject");
export const createdLicenseResponse = licenseResource
	.and(type({ key: /^lic_[A-Za-z0-9_-]{43}$/ }))
	.onUndeclaredKey("reject");
