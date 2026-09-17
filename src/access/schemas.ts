import { type } from "arktype";

export const policyBody = type({
	"maxDevices?": type("1 <= number.integer <= 10000").describe(
		"Maximum registered devices, including blocked registrations. Default 1; allowed range 1–10,000.",
	),
	"maxIps?": type("1 <= number.integer <= 10000").describe(
		"Maximum registered IP addresses, including blocked registrations. Default 1; allowed range 1–10,000.",
	),
	"maxSessions?": type("1 <= number.integer <= 10000").describe(
		"Maximum concurrent active sessions. Default 1; allowed range 1–10,000.",
	),
	"deviceAllowlistEnabled?": type("boolean").describe(
		"Whether activation requires a device present in the device allowlist.",
	),
	"ipAllowlistEnabled?": type("boolean").describe(
		"Whether activation requires an IP matching the network allowlist.",
	),
	"+": "reject",
});
export const allowlistBody = type({
	devices: type("string[] <= 100").describe(
		"Raw device identifiers to allow. Replaces the full list; at most 100 entries.",
	),
	networks: type("string[] <= 100").describe(
		"IPv4/IPv6 addresses or CIDR networks to allow. Replaces the full list; at most 100 entries.",
	),
	"+": "reject",
});
export const registrationParams = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	registrationId: type("string.uuid").describe(
		"UUID of the device or IP registration, not the raw device identifier or address.",
	),
	"+": "reject",
});
export const blockBody = type({
	blocked: type("boolean").describe(
		"True denies this registration; false removes its registration block.",
	),
	"+": "reject",
});
