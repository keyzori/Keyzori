import { type } from "arktype";
import { timestamp } from "../shared/responses.ts";

export const activityResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	licenseId: type("string.uuid | null").describe(
		"UUID of the license this record belongs to.",
	),
	customerId: type("string.uuid | null").describe(
		"UUID of the customer that owns the license.",
	),
	action: type("string").describe(
		"Audit action name, such as license.created or usage.consumed.",
	),
	source: type("string").describe(
		"Source of the action or access block, such as core, manual, or a plugin name.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
	"+": "reject",
});
export const statisticsResponse = type({
	items: type({
		action: type("string").describe("Audit action name."),
		count: type("number.integer").describe(
			"Number of matching events for this action.",
		),
	}).array(),
	retentionDays: type("number.integer").describe(
		"Configured number of days to retain audit events.",
	),
});
export const pruneResponse = type({
	deleted: type("number.integer").describe(
		"Number of audit events permanently removed.",
	),
});
