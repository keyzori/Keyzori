import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.ts";

export function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
export function secret(prefix: "lic" | "ses") {
	return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
export function equalSecret(actual: string, expected: string) {
	return timingSafeEqual(
		Buffer.from(digest(actual), "hex"),
		Buffer.from(digest(expected), "hex"),
	);
}

export function metadata(value: Record<string, unknown> = {}) {
	if (JSON.stringify(value).length > 8192)
		throw new AppError(
			"INVALID_METADATA",
			"Metadata must be at most 8192 characters.",
		);
	return redact(value) as Record<string, unknown>;
}

const sensitive =
	/secret|token|password|authorization|cookie|credential|api.?key|license.?key|key.?hash|device|ip.?address/i;
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 12) return "[REDACTED]";
	if (typeof value === "string")
		return value.replace(
			/\b(?:lic|ses)_[A-Za-z0-9_-]+|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+/g,
			"[REDACTED]",
		);
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				sensitive.test(k) ? "[REDACTED]" : redact(v, depth + 1),
			]),
		);
	return value;
}
