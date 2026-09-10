export class AppError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export function required<T>(
	value: T | null | undefined,
	resource = "Resource",
): T {
	if (value == null)
		throw new AppError("NOT_FOUND", `${resource} not found.`, 404);
	return value;
}

export function databaseCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return;
	if (
		"errno" in error &&
		typeof error.errno === "string" &&
		/^[0-9A-Z]{5}$/.test(error.errno)
	)
		return error.errno;
	if (
		"code" in error &&
		typeof error.code === "string" &&
		/^[0-9A-Z]{5}$/.test(error.code)
	)
		return error.code;
	return "cause" in error ? databaseCode(error.cause) : undefined;
}
