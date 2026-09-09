export type ApiErrorCode =
	| "INVALID_REQUEST"
	| "RATE_LIMITED"
	| "LICENSE_INVALID"
	| "LICENSE_REVOKED"
	| "LICENSE_EXPIRED"
	| "IP_NOT_ALLOWED"
	| "DEVICE_NOT_ALLOWED"
	| "SESSION_INVALID_OR_EXPIRED"
	| "CONCURRENT_SESSION_LIMIT"
	| "METER_NOT_FOUND"
	| "METER_ARCHIVED"
	| "METER_EXHAUSTED"
	| "USAGE_EVENT_CONFLICT"
	| "IP_REGISTRATION_LIMIT"
	| "DEVICE_REGISTRATION_LIMIT"
	| "INTERNAL_ERROR";

export class DomainError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public code: ApiErrorCode = "INVALID_REQUEST",
	) {
		super(message);
		this.name = this.constructor.name;
	}
}

export class NotFoundError extends DomainError {
	constructor(resource: string, code: ApiErrorCode = "INVALID_REQUEST") {
		super(`${resource} not found`, 404, code);
	}
}

export class ConflictError extends DomainError {
	constructor(message: string, code: ApiErrorCode = "INVALID_REQUEST") {
		super(message, 409, code);
	}
}
