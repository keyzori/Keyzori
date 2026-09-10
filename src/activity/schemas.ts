import { type } from "arktype";

export const activityQuery = type({
	"licenseId?": "string.uuid",
	"customerId?": "string.uuid",
	"action?": "string <= 100",
	"source?": "string <= 64",
	"from?": "string.date.iso",
	"to?": "string.date.iso",
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
