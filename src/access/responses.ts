import { type } from "arktype";
import { licenseResponse } from "../licenses/responses.ts";
import { timestamp } from "../shared/responses.ts";

export const deviceResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	fingerprint: type("string").describe(
		"SHA-256 hash of the original device identifier.",
	),
	blocked: type("boolean").describe(
		"Whether this registration is denied access.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
});
export const ipResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	address: type("string").describe("Registered client IP address."),
	blocked: type("boolean").describe(
		"Whether this registration is denied access.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
});
export const registrationResponse = deviceResponse.or(ipResponse);
export const allowlistsResponse = type({
	devices: type({
		fingerprint: type("string").describe(
			"SHA-256 hash of an allowed device identifier.",
		),
	})
		.array()
		.describe(
			"Stored device allowlist; raw device identifiers are not returned.",
		),
	networks: type({
		network: type("string").describe("Normalized IPv4 or IPv6 CIDR network."),
	})
		.array()
		.describe("Stored network allowlist."),
});
export const accessResponse = type({
	license: licenseResponse.describe(
		"License details, excluding its secret key and key hash.",
	),
	allowlists: allowlistsResponse.describe(
		"Stored device hashes and normalized network allowlist entries.",
	),
});
