import { type } from "arktype";

export const activationBody = type({
	key: type(/^lic_[A-Za-z0-9_-]{43}$/).describe(
		"Secret license key. Full keys are returned only when issued or rotated; store securely.",
	),
	deviceId: type("1 <= string <= 256").describe(
		"Stable application device identifier, 1–256 characters. Reuse exactly for this device.",
	),
	"+": "reject",
});
export const sessionHeaders = type({
	authorization: type(/^Bearer ses_[A-Za-z0-9_-]{43}$/).describe(
		"Bearer session token returned by activation, including the Bearer prefix.",
	),
	"x-device-id": type("1 <= string <= 256").describe(
		"The exact deviceId used during activation. Requests must also retain the original client IP.",
	),
});
export const sessionQuery = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	"limit?": type("string.digits").describe("Page size, 1–100. Defaults to 50."),
	"offset?": type("string.digits").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	"+": "reject",
});
export const sessionParams = type({
	id: type("string.uuid").describe(
		"UUID of the license whose session will be terminated.",
	),
	sessionId: type(/^[a-f0-9]{64}$/).describe(
		"Hashed session ID from the admin session listing, not the bearer token.",
	),
	"+": "reject",
});
export const sessionRecord = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	deviceHash: /^[a-f0-9]{64}$/,
	ip: "string",
	revision: type("number.integer > 0").describe(
		"License policy revision recorded when this session was activated.",
	),
	"+": "reject",
});
export type SessionRecord = typeof sessionRecord.infer;
