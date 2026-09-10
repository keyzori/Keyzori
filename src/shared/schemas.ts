import { type } from "arktype";

export const idParams = type({ id: "string.uuid", "+": "reject" });
export const isMetadataObject = (value: unknown) => !Array.isArray(value);
export const metadataSchema = type({ "[string]": "unknown" }).narrow(
	isMetadataObject,
);
export const pageQuery = type({
	"limit?": "string.digits",
	"offset?": "string.digits",
	"+": "reject",
});
export const positiveInteger = type("1 <= number.integer <= 9007199254740991");
export const emptyBody = type({ "+": "reject" });
export const reasonBody = type({ "reason?": "string <= 500", "+": "reject" });

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
