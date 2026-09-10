import { type } from "arktype";
import { positiveInteger } from "../shared/schemas.ts";

export const meterName = type(/^[a-z][a-z0-9_-]{0,63}$/);
export const meterBody = type({
	licenseId: "string.uuid",
	name: meterName,
	limit: "0 <= number.integer <= 9007199254740991",
	"+": "reject",
});
export const meterUpdate = type({
	limit: "0 <= number.integer <= 9007199254740991",
	"+": "reject",
});
export const usageBody = type({
	meter: meterName,
	units: positiveInteger,
	eventId: "1 <= string <= 128",
	"+": "reject",
});
export const usageQuery = type({
	licenseId: "string.uuid",
	"meterId?": "string.uuid",
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
