import { type } from "arktype";
import { timestamp } from "../shared/responses.ts";

export const activityResponse = type({
	id: "string.uuid",
	licenseId: "string.uuid | null",
	customerId: "string.uuid | null",
	action: "string",
	source: "string",
	createdAt: timestamp,
	"+": "reject",
});
export const statisticsResponse = type({
	items: type({ action: "string", count: "number.integer" }).array(),
	retentionDays: "number.integer",
});
export const pruneResponse = type({ deleted: "number.integer" });
