import { type } from "arktype";

export const policyBody = type({
	"maxDevices?": "1 <= number.integer <= 10000",
	"maxIps?": "1 <= number.integer <= 10000",
	"maxSessions?": "1 <= number.integer <= 10000",
	"deviceAllowlistEnabled?": "boolean",
	"ipAllowlistEnabled?": "boolean",
	"+": "reject",
});
export const allowlistBody = type({
	devices: "string[] <= 100",
	networks: "string[] <= 100",
	"+": "reject",
});
export const registrationParams = type({
	id: "string.uuid",
	registrationId: "string.uuid",
	"+": "reject",
});
export const blockBody = type({ blocked: "boolean", "+": "reject" });
