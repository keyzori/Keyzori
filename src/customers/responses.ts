import { type } from "arktype";
import { metadataSchema } from "../shared/schemas.ts";
import { timestamp } from "../shared/responses.ts";

export const customerResponse = type({
	id: "string.uuid",
	email: "string",
	name: "string",
	metadata: metadataSchema,
	createdAt: timestamp,
	updatedAt: timestamp,
	"+": "reject",
});
