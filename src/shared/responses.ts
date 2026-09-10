import { type } from "arktype";

export const timestamp = type("Date");
export const pageResponse = type("<item>", {
	items: "item[]",
	limit: "number.integer",
	offset: "number.integer",
	hasMore: "boolean",
});
export const errorResponse = type({
	error: { code: "string", message: "string" },
});
export const terminationResponse = type({ terminated: "boolean" });
export const statusResponse = type({ status: "string" });
