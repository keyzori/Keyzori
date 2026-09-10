import { type } from "arktype";
import { timestamp } from "../shared/responses.ts";

export const meterResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid",
	name: "string",
	limit: "number.integer",
	used: "number.integer",
	createdAt: timestamp,
	"+": "reject",
});
export const usageResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid",
	meterId: "string.uuid",
	eventId: "string",
	units: "number.integer",
	used: "number.integer",
	remaining: "number.integer",
	createdAt: timestamp,
	"+": "reject",
});
