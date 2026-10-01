import { errors } from "./errors";
import type { $ErrorCode } from "../../types/http";

export class HttpError extends Error {
	readonly status;
	constructor(
		readonly code: $ErrorCode,
		readonly details?: Record<string, string>,
		readonly resourceIds?: string[],
		readonly retryAfter?: number,
	) {
		super(errors[code][1]);
		this.status = errors[code][0];
	}
	response() {
		return {
			code: this.code,
			reason: this.message,
			...(this.details ? { errors: this.details } : {}),
			...(this.resourceIds ? { ids: this.resourceIds } : {}),
		};
	}
}
