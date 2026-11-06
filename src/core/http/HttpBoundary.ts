import { DrizzleQueryError } from "drizzle-orm/errors";
import { ParseError, ValidationError } from "elysia";
import { HttpError } from "./HttpError";
import { InputPolicy } from "./InputPolicy";
import { Replay } from "../security/Replay";
import { success, type ApiResponse } from "./Response";
import type { Logger } from "../observability/Logger";
import type { RequestTracker } from "./RequestTracker";

export class HttpBoundary {
	private readonly input = new InputPolicy();
	constructor(
		private readonly tracker: RequestTracker,
		private readonly logger: Logger,
	) {}
	start(request: Request) {
		const context = this.tracker.begin(request);
		if (this.tracker.draining) throw new HttpError("SERVICE_UNAVAILABLE");
		const contentLength = request.headers.get("content-length");
		if (
			contentLength &&
			(!/^\d+$/.test(contentLength) || Number(contentLength) > 1048576)
		)
			throw new HttpError("PAYLOAD_TOO_LARGE");
		if (
			["POST", "PATCH", "DELETE"].includes(request.method) &&
			request.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() !== "application/json"
		)
			throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
		return context;
	}
	async parse(request: Request) {
		if (!["POST", "PATCH", "DELETE"].includes(request.method)) return;
		const reader = request.body?.getReader();
		if (!reader) throw new HttpError("INVALID_REQUEST");
		const chunks = [];
		let size = 0;
		const context = this.tracker.begin(request);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					void reader.cancel().catch(() => undefined);
					reject(new HttpError("INVALID_REQUEST"));
				},
				Math.max(1, context.deadlineAt - Date.now()),
			);
		});
		try {
			while (true) {
				const result = await Promise.race([reader.read(), deadline]);
				if (result.done) break;
				size += result.value.byteLength;
				if (size > 1048576) {
					void reader.cancel().catch(() => undefined);
					throw new HttpError("PAYLOAD_TOO_LARGE");
				}
				chunks.push(result.value);
			}
			try {
				const body: unknown = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					),
				);
				if (body && typeof body === "object" && !Array.isArray(body)) {
					if ("metadata" in body) this.input.metadata(body.metadata);
					if (
						"changes" in body &&
						body.changes &&
						typeof body.changes === "object" &&
						"metadata" in body.changes
					)
						this.input.metadata(body.changes.metadata);
				}
				this.input.jsonText(body);
				return body;
			} catch {
				throw new HttpError("INVALID_REQUEST");
			}
		} finally {
			clearTimeout(timer);
			reader.releaseLock();
		}
	}
	error(error: unknown, request: Request, code?: string) {
		if (
			!code &&
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string"
		)
			code = error.code;
		if (error instanceof Replay)
			return Response.json(
				success(error.result, this.tracker.begin(request).requestId, 50, true),
			);
		let mapped: HttpError;
		if (error instanceof HttpError) mapped = error;
		else if (error instanceof ParseError && error.cause instanceof HttpError)
			mapped = error.cause;
		else if (error instanceof ValidationError)
			mapped = new HttpError(
				error.type === "response" ? "INTERNAL_ERROR" : "INVALID_REQUEST",
				error.type === "response" ? undefined : validationDetails(error),
			);
		else if (code === "NOT_FOUND" || code === "not-found")
			mapped = new HttpError("NOT_FOUND");
		else if (code === "PARSE" || code === "parse")
			mapped = new HttpError("INVALID_REQUEST");
		else if (this.unavailable(error))
			mapped = new HttpError("SERVICE_UNAVAILABLE");
		else mapped = new HttpError("INTERNAL_ERROR");
		if (mapped.status >= 500)
			this.logger.write("error", "request.failed", {
				requestId: this.tracker.begin(request).requestId,
				code: mapped.code,
				status: mapped.status,
				...diagnostic(error),
			});
		const body: ApiResponse<never> = {
			ok: false,
			data: null,
			error: {
				code: mapped.code,
				message: mapped.message,
				retryable: mapped.status === 429 || mapped.status === 503,
				...(mapped.details
					? {
							details: Object.entries(mapped.details)
								.slice(0, 16)
								.map(([path, message]) => ({
									path: path.slice(0, 128),
									message: message.slice(0, 256),
								})),
						}
					: {}),
				...(mapped.resourceIds
					? {
							resourceIds: [
								...new Set(
									mapped.resourceIds.filter((id) =>
										/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
											id,
										),
									),
								),
							].slice(0, 100),
						}
					: {}),
			},
			meta: { requestId: this.tracker.begin(request).requestId },
		};
		return Response.json(body, {
			status: mapped.status,
			headers: {
				...(mapped.retryAfter
					? { "Retry-After": String(mapped.retryAfter) }
					: {}),
				...(mapped.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
			},
		});
	}
	private unavailable(error: unknown): boolean {
		if (error instanceof DrizzleQueryError)
			return this.unavailable(error.cause);
		return (
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string" &&
			/^(ERR_POSTGRES_CONNECTION|ERR_POSTGRES_AUTH|ERR_REDIS|ECONN|ETIMEDOUT|08|53|57P|25P04|55P03|57014)/.test(
				error.code,
			)
		);
	}
}

/** Diagnostic labels are a closed vocabulary; only validated SQLSTATEs may vary. */
function diagnostic(error: unknown): { phase: string; cause: string } {
	if (error instanceof ValidationError)
		return {
			phase: error.type === "response" ? "response" : "validation",
			cause: "schema_validation",
		};
	if (error instanceof ParseError)
		return { phase: "parse", cause: "body_parse" };
	let current = error;
	for (let depth = 0; depth < 6; depth++) {
		if (!current || typeof current !== "object") break;
		for (const property of ["errno", "code"] as const) {
			const value: unknown =
				property in current ? Reflect.get(current, property) : undefined;
			if (
				typeof value === "string" &&
				/^(?:[0-9]{2}|P0|XX|HV)[0-9A-Z]{3}$/.test(value)
			)
				return { phase: "database", cause: `SQLSTATE_${value}` };
		}
		current = "cause" in current ? current.cause : undefined;
	}
	if (error instanceof DrizzleQueryError)
		return { phase: "database", cause: "query_error" };
	return {
		phase: "request",
		cause:
			error instanceof TypeError
				? "TypeError"
				: error instanceof RangeError
					? "RangeError"
					: error instanceof SyntaxError
						? "SyntaxError"
						: error instanceof HttpError
							? "HttpError"
							: error instanceof Error
								? "Error"
								: "unknown",
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns only schema-declared field names; arbitrary metadata keys are redacted. */
function field(
	schema: unknown,
	part: string,
	seen = new Set<unknown>(),
): unknown {
	if (!record(schema) || seen.has(schema)) return;
	seen.add(schema);
	if (record(schema.properties) && Object.hasOwn(schema.properties, part))
		return schema.properties[part];
	if (schema.items && /^(0|[1-9][0-9]*)$/.test(part)) return schema.items;
	for (const kind of ["anyOf", "oneOf", "allOf"]) {
		const branches = schema[kind];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			const found = field(branch, part, seen);
			if (found !== undefined) return found;
		}
	}
}

function validationDetails(error: ValidationError): Record<string, string> {
	const details: Record<string, string> = {};
	const errors: unknown[] = error.errors;
	const location = ["body", "query", "params", "headers", "cookie"].includes(
		error.type ?? "",
	)
		? error.type
		: "input";
	for (const issue of errors.slice(0, 16)) {
		if (!record(issue)) continue;
		let schema: unknown = error.schema;
		let path = location ?? "input";
		const raw =
			typeof issue.instancePath === "string" ? issue.instancePath : "";
		for (const segment of raw.split("/").slice(1, 17)) {
			const part = segment.replace(/~1/g, "/").replace(/~0/g, "~");
			const next = field(schema, part);
			if (next === undefined) {
				path += ".*";
				break;
			}
			path += /^\d+$/.test(part) ? `[${part}]` : `.${part}`;
			schema = next;
		}
		details[path.slice(0, 128)] =
			issue.keyword === "required"
				? "Required field is missing"
				: "Invalid value";
	}
	if (Object.keys(details).length === 0)
		details[location ?? "input"] = "Invalid value";
	return details;
}
