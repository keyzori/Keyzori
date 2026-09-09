import { isIP } from "node:net";
import type { TrustedProxyHeader } from "./controllers/clientIp";

export interface ServerConfig {
	databaseUrl: string;
	redisUrl: string;
	adminPass: string;
	host: string;
	port: number;
	trustProxyHeaders: boolean;
	trustedProxyCidrs: string[];
	trustedProxyHeader: TrustedProxyHeader;
	openapiEnabled: boolean;
	rateLimitPerMinute: number;
	licenseRateLimitPerMinute: number;
	rateLimitPerIpPerMinute: number;
	maxRequestBodyBytes: number;
	stripe: StripeConfig | null;
	eventRetentionDays: number;
}

export interface StripeConfig {
	secretKey: string;
	webhookSecret: string;
}

function trustedProxyCidrs(
	environment: Record<string, string | undefined>,
	enabled: boolean,
): string[] {
	const configured = environment.KEYZORI_TRUSTED_PROXY_CIDRS?.trim() ?? "";
	if (configured === "*") return ["*"];
	const values = configured
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (enabled && values.length === 0) {
		throw new Error(
			"KEYZORI_TRUSTED_PROXY_CIDRS must list the immediate proxy networks when KEYZORI_TRUST_PROXY_HEADERS is true.",
		);
	}
	for (const value of values) {
		if (value === "*") {
			throw new Error(
				"KEYZORI_TRUSTED_PROXY_CIDRS must be either * or comma-separated IPv4 or IPv6 CIDR ranges.",
			);
		}
		const [address, prefixText, extra] = value.split("/");
		const family = address ? isIP(address) : 0;
		const maximum = family === 4 ? 32 : 128;
		const prefix = Number(prefixText);
		if (
			extra !== undefined ||
			family === 0 ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > maximum
		) {
			throw new Error(
				"KEYZORI_TRUSTED_PROXY_CIDRS must contain comma-separated IPv4 or IPv6 CIDR ranges.",
			);
		}
	}
	return values;
}

function required(
	environment: Record<string, string | undefined>,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (value) return value;

	throw new Error(`${name} must be configured.`);
}

function serviceUrl(
	environment: Record<string, string | undefined>,
	name: "KEYZORI_DATABASE_URL" | "KEYZORI_REDIS_URL",
	protocols: readonly string[],
): string {
	const value = required(environment, name);
	let protocol: string;
	try {
		protocol = new URL(value).protocol;
	} catch {
		throw new Error(`${name} must be a valid URL.`);
	}
	if (!protocols.includes(protocol)) {
		throw new Error(
			`${name} must use ${protocols.map((entry) => entry.replace(":", "")).join(" or ")}.`,
		);
	}
	return value;
}

function booleanValue(
	environment: Record<string, string | undefined>,
	name: string,
	fallback: boolean,
): boolean {
	const value = environment[name];
	if (value === undefined || value === "") return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be either true or false.`);
}

function integerValue(
	environment: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = environment[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return value;
}

function parseTrustedProxyHeaderMode(
	environment: Record<string, string | undefined>,
): TrustedProxyHeader {
	const value =
		environment.KEYZORI_TRUSTED_PROXY_HEADER?.trim() || "x-forwarded-for";
	if (
		value !== "x-forwarded-for" &&
		value !== "cf-connecting-ip" &&
		value !== "x-real-ip" &&
		value !== "*"
	) {
		throw new Error(
			"KEYZORI_TRUSTED_PROXY_HEADER must be x-forwarded-for, cf-connecting-ip, x-real-ip, or *.",
		);
	}
	return value;
}

export function loadServerConfig(
	environment: Record<string, string | undefined> = Bun.env,
): ServerConfig {
	const host = environment.KEYZORI_SERVER_HOST?.trim() || "0.0.0.0";
	const adminPass = environment.KEYZORI_ADMIN_PASS?.trim();
	if (!adminPass) {
		throw new Error("KEYZORI_ADMIN_PASS must be configured.");
	}
	const trustProxyHeaders = booleanValue(
		environment,
		"KEYZORI_TRUST_PROXY_HEADERS",
		false,
	);
	const serverPort = integerValue(
		environment,
		"KEYZORI_SERVER_PORT",
		3000,
		1,
		65_535,
	);
	const stripeSecretKey = environment.KEYZORI_STRIPE_SECRET_KEY?.trim() ?? "";
	const stripeWebhookSecret =
		environment.KEYZORI_STRIPE_WEBHOOK_SECRET?.trim() ?? "";
	if (Boolean(stripeSecretKey) !== Boolean(stripeWebhookSecret)) {
		throw new Error(
			"KEYZORI_STRIPE_SECRET_KEY and KEYZORI_STRIPE_WEBHOOK_SECRET must either both be configured or both be omitted.",
		);
	}
	let stripe: StripeConfig | null = null;
	if (stripeSecretKey && stripeWebhookSecret) {
		if (
			stripeSecretKey.length < 16 ||
			/^(replace|change|example|development)/i.test(stripeSecretKey)
		) {
			throw new Error("KEYZORI_STRIPE_SECRET_KEY is not a valid secret.");
		}
		if (
			!stripeWebhookSecret.startsWith("whsec_") ||
			stripeWebhookSecret.length < 16
		) {
			throw new Error(
				"KEYZORI_STRIPE_WEBHOOK_SECRET must be a valid whsec_ secret.",
			);
		}
		stripe = {
			secretKey: stripeSecretKey,
			webhookSecret: stripeWebhookSecret,
		};
	}

	return {
		databaseUrl: serviceUrl(environment, "KEYZORI_DATABASE_URL", [
			"postgres:",
			"postgresql:",
		]),
		redisUrl: serviceUrl(environment, "KEYZORI_REDIS_URL", [
			"redis:",
			"rediss:",
		]),
		adminPass,
		host,
		port: serverPort,
		trustProxyHeaders,
		trustedProxyCidrs: trustedProxyCidrs(environment, trustProxyHeaders),
		trustedProxyHeader: parseTrustedProxyHeaderMode(environment),
		openapiEnabled: booleanValue(environment, "KEYZORI_OPENAPI_ENABLED", true),
		rateLimitPerMinute: integerValue(
			environment,
			"KEYZORI_RATE_LIMIT_PER_MINUTE",
			60,
			1,
			100_000,
		),
		licenseRateLimitPerMinute: integerValue(
			environment,
			"KEYZORI_LICENSE_RATE_LIMIT_PER_MINUTE",
			30,
			1,
			100_000,
		),
		rateLimitPerIpPerMinute: integerValue(
			environment,
			"KEYZORI_RATE_LIMIT_PER_IP_PER_MINUTE",
			6_000,
			1,
			1_000_000,
		),
		maxRequestBodyBytes: integerValue(
			environment,
			"KEYZORI_MAX_REQUEST_BODY_BYTES",
			65_536,
			1_024,
			10_485_760,
		),
		stripe,
		eventRetentionDays: integerValue(
			environment,
			"KEYZORI_EVENT_RETENTION_DAYS",
			30,
			1,
			365,
		),
	};
}
