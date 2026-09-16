import { type } from "arktype";

export const timestamp = type("Date");
export const pageResponse = type("<item>", {
	items: ["item[]", "@", { description: "Records in this page." }],
	limit: type("number.integer").describe("Page size, 1–100. Defaults to 50."),
	offset: type("number.integer").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	hasMore: type("boolean").describe(
		"Whether another page exists after this page.",
	),
});
export const errorResponse = type({
	error: {
		code: type("string").describe("Stable machine-readable error code."),
		message: type("string").describe(
			"Human-readable explanation of the failure.",
		),
	},
});
export const terminationResponse = type({
	terminated: type("boolean").describe(
		"Whether session termination completed.",
	),
});
export const statusResponse = type({
	status: type("string").describe(
		"ok for liveness; ready when startup and dependency checks succeed.",
	),
});
