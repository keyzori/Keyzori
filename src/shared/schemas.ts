import { type } from "arktype";

export const idParams = type({
	id: type("string.uuid").describe(
		"Resource UUID. See the operation description for which resource this route identifies.",
	),
	"+": "reject",
});
export const isMetadataObject = (value: unknown) => !Array.isArray(value);
export const metadataSchema = type({ "[string]": "unknown" }).narrow(
	isMetadataObject,
);
export const pageQuery = type({
	"limit?": type("string.digits").describe("Page size, 1–100. Defaults to 50."),
	"offset?": type("string.digits").describe(
		"Number of records to skip, 0–1,000,000. Defaults to 0.",
	),
	"+": "reject",
});
export const positiveInteger = type("1 <= number.integer <= 9007199254740991");
export const emptyBody = type({ "+": "reject" }).describe(
	"Send an empty JSON object: {}.",
);
export const reasonBody = type({
	"reason?": type("string <= 500").describe(
		"Optional reason for the manual access block; sensitive values are redacted.",
	),
	"+": "reject",
});

export function pagination(query: typeof pageQuery.infer) {
	const limit = Number(query.limit ?? 50);
	const offset = Number(query.offset ?? 0);
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > 1000000
	) {
		throw new AppError(
			"INVALID_PAGE",
			"Limit must be 1–100 and offset 0–1000000.",
		);
	}
	return { limit, offset };
}
export type Page = ReturnType<typeof pagination>;
export function collection<T>(rows: T[], page: Page) {
	return {
		items: rows.slice(0, page.limit),
		...page,
		hasMore: rows.length > page.limit,
	};
}

import { AppError } from "./errors.ts";
