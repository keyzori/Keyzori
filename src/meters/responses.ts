import { type } from "arktype";
import { timestamp } from "../shared/responses.ts";

export const meterResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	name: type("string").describe(
		"Meter name unique within a license. Starts with a lowercase letter; may contain lowercase letters, digits, underscores, and hyphens.",
	),
	limit: type("number.integer").describe(
		"Maximum total units allowed. Zero disables consumption; cannot be below units already used.",
	),
	used: type("number.integer").describe(
		"Total units consumed. On a receipt, the total recorded when that event was accepted.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
	"+": "reject",
});
export const usageResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	meterId: type("string.uuid").describe(
		"UUID of a meter. When supplied as a filter, results are restricted to that meter.",
	),
	eventId: type("string").describe(
		"Client-generated identifier for one logical event, unique per license. Reuse with identical meter and units for retries.",
	),
	units: type("number.integer").describe(
		"Positive safe integer number of units to consume.",
	),
	used: type("number.integer").describe(
		"Total units consumed. On a receipt, the total recorded when that event was accepted.",
	),
	remaining: type("number.integer").describe(
		"Units remaining when this usage event was accepted; replay returns the original value.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
	"+": "reject",
});
