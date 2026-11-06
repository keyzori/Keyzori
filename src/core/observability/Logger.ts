import { errors } from "../http/errors";

const safeCauses = new Set([
	...Object.keys(errors),
	"schema_validation",
	"body_parse",
	"query_error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"HttpError",
	"Error",
	"unknown",
	"UNEXPECTED_ERROR",
	"DEPENDENCY_UNAVAILABLE",
	"TIMEOUT",
	"CONNECTION_FAILED",
	"AUTHENTICATION_FAILED",
	"SCHEMA_INCOMPATIBLE",
	"UNSUPPORTED_DATABASE_VERSION",
	"MIGRATION_ROLE_REQUIRED",
]);

export class Logger {
	private readonly levels = { debug: 0, info: 1, warn: 2, error: 3 };
	constructor(
		private readonly level: "debug" | "info" | "warn" | "error" = "info",
	) {}
	/** Error messages, SQL, URLs and nested driver details are never diagnostic output. */
	static cause(error: unknown): string {
		let current = error;
		for (let depth = 0; depth < 6; depth++) {
			if (!current || typeof current !== "object") break;
			if (
				"name" in current &&
				["TimeoutError", "AbortError"].includes(String(current.name))
			)
				return "TIMEOUT";
			for (const property of ["errno", "code"] as const) {
				const code: unknown =
					property in current ? Reflect.get(current, property) : undefined;
				if (typeof code !== "string") continue;
				if (/^(?:[0-9]{2}|P0|XX|HV)[0-9A-Z]{3}$/.test(code))
					return `SQLSTATE_${code}`;
				if (Object.hasOwn(errors, code) || safeCauses.has(code)) return code;
				if (
					[
						"ECONNREFUSED",
						"ECONNRESET",
						"ENOTFOUND",
						"ERR_POSTGRES_CONNECTION_CLOSED",
						"ERR_POSTGRES_CONNECTION_TIMEOUT",
						"ERR_POSTGRES_CONNECTION_REFUSED",
					].includes(code)
				)
					return "CONNECTION_FAILED";
			}
			current = "cause" in current ? current.cause : undefined;
		}
		return "UNEXPECTED_ERROR";
	}
	write(
		level: "debug" | "info" | "warn" | "error",
		event: string,
		fields: {
			requestId?: string;
			code?: string;
			status?: number;
			resourceId?: string;
			phase?: string;
			cause?: string;
		} = {},
	) {
		if (this.levels[level] < this.levels[this.level]) return;
		console.log(
			JSON.stringify({
				time: new Date().toISOString(),
				level,
				event,
				requestId: fields.requestId,
				code: fields.code,
				status: fields.status,
				resourceId: fields.resourceId,
				phase: fields.phase,
				cause:
					fields.cause === undefined
						? undefined
						: safeCauses.has(fields.cause) ||
								/^SQLSTATE_(?:[0-9]{2}|P0|XX|HV)[0-9A-Z]{3}$/.test(fields.cause)
							? fields.cause
							: "UNEXPECTED_ERROR",
			}),
		);
	}
}
