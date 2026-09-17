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
	/(?:^|[^a-z0-9])(?:secrets?|tokens?|passwords?|authorizations?|cookies?|credentials?|api[^a-z0-9]*keys?|license[^a-z0-9]*keys?|key[^a-z0-9]*hash(?:es)?|device[^a-z0-9]*(?:ids?|hash(?:es)?)|ip[^a-z0-9]*address(?:es)?)(?:$|[^a-z0-9])|^device$/i;
const sensitiveSuffix =
	/(?:secret|token|password|authorization|cookie|credential|apikey|licensekey|keyhash|deviceid|devicehash|ipaddress)\d*$/i;
function sensitiveKey(key: string) {
	const normalized = key
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	return (
		sensitive.test(normalized) ||
		sensitiveSuffix.test(normalized.replace(/[^a-z0-9]/gi, ""))
	);
}
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
				sensitiveKey(k) ? "[REDACTED]" : redact(v, depth + 1),
			]),
		);
	return value;
}
