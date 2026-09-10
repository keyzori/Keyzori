import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";

export const customerBody = type({
	email: "string.email <= 254",
	name: "1 <= string <= 200",
	"metadata?": metadataSchema,
	"+": "reject",
});
