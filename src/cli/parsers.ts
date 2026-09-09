export interface CollectedMeter {
	name: string;
	balance: number;
}
import type { JsonObject, JsonValue, LicenseType } from "../domain/entities";
import { LICENSE_TYPES } from "../domain/entities";
import { MAX_LICENSE_LIMIT } from "../domain/licenseLimits";
import { InvalidArgumentError } from "commander";

function invalid(message: string): never {
	throw new InvalidArgumentError(message);
}

export function parseInteger(
	value: string,
	options: { label?: string; minimum?: number; allowNegative?: boolean } = {},
): number {
	const label = options.label ?? "value";
	const pattern = options.allowNegative ? /^-?\d+$/ : /^\d+$/;
	if (!pattern.test(value)) invalid(`${label} must be an integer.`);
	const parsed = Number(value);
	const minimum =
		options.minimum ?? (options.allowNegative ? -MAX_LICENSE_LIMIT : 0);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < minimum ||
		parsed > MAX_LICENSE_LIMIT
	) {
		invalid(`${label} must be between ${minimum} and ${MAX_LICENSE_LIMIT}.`);
	}
	return parsed;
}

export function parseNonNegativeInteger(value: string): number {
	return parseInteger(value, { label: "value" });
}

export function parsePositiveInteger(value: string): number {
	return parseInteger(value, { label: "value", minimum: 1 });
}

export function parseNonZeroInteger(value: string): number {
	const parsed = parseInteger(value, { label: "value", allowNegative: true });
	if (parsed === 0) invalid("value must not be zero.");
	return parsed;
}

export function parseLicenseType(value: string): LicenseType {
	if ((LICENSE_TYPES as readonly string[]).includes(value)) {
		return value as LicenseType;
	}
	return invalid(`type must be one of: ${LICENSE_TYPES.join(", ")}.`);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every(isJsonValue)
	);
}

export function parseMetadata(value: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return invalid("metadata must be valid JSON.");
	}
	if (!isJsonObject(parsed)) return invalid("metadata must be a JSON object.");
	return parsed;
}

export function parseIsoDate(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return invalid("date must be a valid ISO 8601 date.");
	}
	return parsed.toISOString();
}

export function parseReason(value: string): string {
	const reason = value.trim();
	if (!reason || reason.length > 500) {
		return invalid("reason must contain between 1 and 500 characters.");
	}
	return reason;
}

export function collectMeter(
	value: string,
	previous: CollectedMeter[],
): CollectedMeter[] {
	const separator = value.lastIndexOf("=");
	if (separator <= 0 || separator === value.length - 1) {
		return invalid('meter must use the format "name=balance".');
	}
	const name = value.slice(0, separator).trim();
	if (!name || name.length > 128) {
		return invalid("meter name must contain between 1 and 128 characters.");
	}
	if (previous.some((meter) => meter.name === name)) {
		return invalid(
			`meter ${JSON.stringify(name)} was provided more than once.`,
		);
	}
	const balance = parseInteger(value.slice(separator + 1), {
		label: "meter balance",
	});
	return [...previous, { name, balance }];
}

export function requireValue(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required.`);
	return normalized;
}
