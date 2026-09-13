import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const customerBody = type({
	email: type("string.email <= 254").describe(
		"Customer email address. Stored in lowercase and unique across customers.",
	),
	name: type("1 <= string <= 200").describe("Customer display name."),
	"metadata?": metadataSchema.describe(
		"Custom JSON object. At most 8,192 serialized characters; sensitive values are redacted.",
	),
	"+": "reject",
});
