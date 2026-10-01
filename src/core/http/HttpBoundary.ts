import { DrizzleQueryError } from "drizzle-orm/errors";
import { ValidationError } from "elysia";
import { HttpError } from "./HttpError";
import { InputPolicy } from "./InputPolicy";
import { Replay } from "../security/Replay";
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
					Buffer.concat(chunks).toString("utf8"),
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
		if (error instanceof Replay) return Response.json(error.result);
		let mapped = new HttpError("INTERNAL_ERROR");
		if (error instanceof HttpError) mapped = error;
		else if (error instanceof ValidationError)
			mapped = new HttpError(
				error.type === "response" ? "INTERNAL_ERROR" : "INVALID_REQUEST",
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
			});
		return Response.json(mapped.response(), {
			status: mapped.status,
			headers: mapped.retryAfter
				? { "Retry-After": String(mapped.retryAfter) }
				: undefined,
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
