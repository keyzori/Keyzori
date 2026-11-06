import type { $ErrorCode } from "../../types/http";
import { TypeBoxValidator, type Validator, ValidationError } from "elysia";
import { metadataDefinitions } from "./model";

export type ApiResponse<T> =
	| { ok: true; data: T; error: null; meta: ResponseMeta }
	| {
			ok: false;
			data: null;
			error: {
				code: $ErrorCode;
				message: string;
				retryable: boolean;
				details?: { path: string; message: string }[];
				resourceIds?: string[];
			};
			meta: ResponseMeta;
	  };
export type ResponseMeta = {
	requestId: string;
	page?: { limit: number; nextCursor: string | null; hasMore: boolean };
	operation?: { replayed: boolean };
};

/** Wraps validated route payloads; protocol Responses (metrics/upgrade) bypass this. */
export function success(
	value: unknown,
	requestId: string,
	limit = 50,
	replayed = false,
): ApiResponse<unknown> {
	const meta: ResponseMeta = { requestId };
	let data = value;
	if (value && typeof value === "object" && "data" in value) {
		if (
			"pageLimit" in value &&
			typeof value.pageLimit === "number" &&
			Number.isInteger(value.pageLimit) &&
			value.pageLimit >= 1 &&
			value.pageLimit <= 100
		)
			limit = value.pageLimit;
		data = value.data;
		if (
			"credential" in value &&
			data &&
			typeof data === "object" &&
			!Array.isArray(data)
		)
			data = { ...data, credential: value.credential };
		if (
			"secret" in value &&
			data &&
			typeof data === "object" &&
			!Array.isArray(data)
		)
			data = { ...data, secret: value.secret };
		if ("nextCursor" in value) {
			const nextCursor =
				typeof value.nextCursor === "string" ? value.nextCursor : null;
			meta.page = { limit, nextCursor, hasMore: nextCursor !== null };
		}
		if ("cursor" in value && typeof value.cursor === "string")
			meta.page = {
				limit,
				nextCursor: value.cursor,
				hasMore: "hasMore" in value && value.hasMore === true,
			};
	}
	if (replayed) meta.operation = { replayed: true };
	return { ok: true, data, error: null, meta };
}

/** Elysia 2 maps before validating and skips native Responses. Validate before wrapping. */
export function responseValidator(
	schema: Parameters<typeof Validator.response>[0],
) {
	// Elysia's route snapshots can contain plain JSON schemas without ~kind.
	// TypeBoxValidator accepts both these and the original tagged schemas.
	const schemas =
		schema &&
		typeof schema === "object" &&
		Object.keys(schema).every((key) => /^\d{3}$/.test(key))
			? schema
			: { 200: schema };
	const validators = new Map<number, TypeBoxValidator>();
	for (const [status, value] of Object.entries(schemas)) {
		if (value == null) continue;
		if (typeof value !== "object" || "~standard" in value)
			throw new Error("Expected a TypeBox response schema");
		validators.set(
			Number(status),
			new TypeBoxValidator(value, {
				normalize: false,
				models: metadataDefinitions,
			}),
		);
	}
	return (value: unknown, status: number) => {
		const validator = validators.get(status);
		if (validator && !validator.Check(value))
			throw new ValidationError("response", value, () =>
				validator.Errors(value),
			);
	};
}
