import { type } from "arktype";

export const activityQuery = type({
	"licenseId?": type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	"customerId?": type("string.uuid").describe(
		"UUID of the customer that owns the license.",
	),
	"action?": type("string <= 100").describe(
		"Audit action name, such as license.created or usage.consumed.",
	),
	"source?": type("string <= 64").describe(
		"Source of the action or access block, such as core, manual, or a plugin name.",
	),
	"from?": type("string.date.iso").describe(
		"Inclusive ISO 8601 start timestamp for the activity filter.",
	),
	"to?": type("string.date.iso").describe(
		"Inclusive ISO 8601 end timestamp; must not precede from.",
	),
	"limit?": type("string.digits").describe("Page size, 1–100. Defaults to 50."),
	"offset?": type("string.digits").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	"+": "reject",
});
