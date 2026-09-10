import { type } from "arktype";
import { licenseResponse } from "../licenses/responses.ts";
import { timestamp } from "../shared/responses.ts";

export const deviceResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid",
	fingerprint: "string",
	blocked: "boolean",
	createdAt: timestamp,
});
export const ipResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid",
	address: "string",
	blocked: "boolean",
	createdAt: timestamp,
});
export const registrationResponse = deviceResponse.or(ipResponse);
export const allowlistsResponse = type({
	devices: type({ fingerprint: "string" }).array(),
	networks: type({ network: "string" }).array(),
});
export const accessResponse = type({
	license: licenseResponse,
	allowlists: allowlistsResponse,
});
