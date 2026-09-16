import { type } from "arktype";
import { positiveInteger } from "../shared/schemas.ts";

export const meterName = type(/^[a-z][a-z0-9_-]{0,63}$/).describe(
	"Meter name unique within a license. Starts with a lowercase letter and allows lowercase letters, digits, underscores, and hyphens; for example exports.",
);
export const meterBody = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	name: meterName,
	limit: type("0 <= number.integer <= 9007199254740991").describe(
		"Maximum total units allowed. Zero disables consumption; cannot be below units already used.",
	),
	"+": "reject",
});
export const meterUpdate = type({
	limit: type("0 <= number.integer <= 9007199254740991").describe(
		"Maximum total units allowed. Zero disables consumption; cannot be below units already used.",
	),
	"+": "reject",
});
export const usageBody = type({
	meter: meterName,
	units: positiveInteger.describe(
		"Positive safe integer number of units to consume.",
	),
	eventId: type("1 <= string <= 128").describe(
		"Client-generated identifier for one logical event, unique per license. Reuse with identical meter and units for retries.",
	),
	"+": "reject",
});
export const usageQuery = type({
	licenseId: type("string.uuid").describe(
		"UUID of the license this record belongs to.",
	),
	"meterId?": type("string.uuid").describe(
		"UUID of a meter. When supplied as a filter, results are restricted to that meter.",
	),
	"limit?": type("string.digits").describe("Page size, 1–100. Defaults to 50."),
	"offset?": type("string.digits").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	"+": "reject",
});
