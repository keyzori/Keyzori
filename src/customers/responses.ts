import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";
import { timestamp } from "../shared/responses.ts";

export const customerResponse = type({
	id: type("string.uuid").describe(
		"Resource identifier. Use the identifier returned by the corresponding create or list operation.",
	),
	email: type("string").describe(
		"Customer email address. Stored in lowercase and unique across customers.",
	),
	name: type("string").describe("Customer display name."),
	metadata: metadataSchema.describe(
		"Custom JSON object. At most 8,192 serialized characters; sensitive values are redacted.",
	),
	createdAt: timestamp.describe(
		"ISO 8601 timestamp when this record was created.",
	),
	updatedAt: timestamp.describe(
		"ISO 8601 timestamp of the most recent update.",
	),
	"+": "reject",
});
