import { type } from "arktype";

export const activationBody = type({
	key: /^lic_[A-Za-z0-9_-]{43}$/,
	deviceId: "1 <= string <= 256",
	"+": "reject",
});
export const sessionHeaders = type({
	authorization: /^Bearer ses_[A-Za-z0-9_-]{43}$/,
	"x-device-id": "1 <= string <= 256",
});
export const sessionQuery = type({
	licenseId: "string.uuid",
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
export const sessionParams = type({
	id: "string.uuid",
	sessionId: /^[a-f0-9]{64}$/,
	"+": "reject",
});
export const sessionRecord = type({
	licenseId: "string.uuid",
	deviceHash: /^[a-f0-9]{64}$/,
	ip: "string",
	revision: "number.integer > 0",
	"+": "reject",
});
export type SessionRecord = typeof sessionRecord.infer;
