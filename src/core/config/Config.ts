import { isIP } from "node:net";
import type { $Environment } from "../../types/config";

export class Config {
	readonly databaseUrl;
	readonly redisUrl;
	readonly masterKey;
	readonly host;
	readonly port;
	readonly poolSize;
	readonly trustedProxies;
	readonly clientIpHeaders;
	readonly logLevel: "debug" | "info" | "warn" | "error";

	constructor(environment: $Environment = Bun.env) {
		this.databaseUrl = this.url(environment, "KZ_DATABASE_URL", [
			"postgres:",
			"postgresql:",
		]);
		this.redisUrl = this.url(environment, "KZ_REDIS_URL", [
			"redis:",
			"rediss:",
		]);
		this.masterKey = this.required(environment, "KZ_MASTER_KEY");
		if (!/^kz_key_[a-fA-F0-9]{64}$/.test(this.masterKey)) {
			throw new Error(
				"KZ_MASTER_KEY must use kz_key_ followed by 64 hexadecimal characters",
			);
		}
		this.host = environment.KZ_API_HOST ?? "0.0.0.0";
		if (!isIP(this.host)) throw new Error("KZ_API_HOST must be an IP address");
		this.port = this.integer(environment, "KZ_API_PORT", 6284, 65535);
		this.poolSize = this.integer(
			environment,
			"KZ_DATABASE_POOL_SIZE",
			10,
			1000,
		);
		this.trustedProxies = this.list(environment.KZ_TRUSTED_PROXIES);
		for (const address of this.trustedProxies) {
			const [host, mask, extra] = address.split("/");
			const family = host ? isIP(host) : 0;
			if (
				!family ||
				extra !== undefined ||
				(mask !== undefined &&
					(!/^(0|[1-9][0-9]*)$/.test(mask) ||
						Number(mask) > (family === 4 ? 32 : 128)))
			) {
				throw new Error(
					"KZ_TRUSTED_PROXIES must contain IP addresses or CIDRs",
				);
			}
		}
		const clientIpHeaders = this.list(environment.KZ_CLIENT_IP_HEADERS).map(
			(header) => header.toLowerCase(),
		);
		if (
			clientIpHeaders.some(
				(header) =>
					!["cf-connecting-ip", "x-real-ip", "x-forwarded-for"].includes(
						header,
					),
			)
		) {
			throw new Error("KZ_CLIENT_IP_HEADERS contains an unsupported header");
		}
		this.clientIpHeaders = clientIpHeaders;
		const level = environment.KZ_LOG_LEVEL ?? "info";
		if (
			level !== "debug" &&
			level !== "info" &&
			level !== "warn" &&
			level !== "error"
		) {
			throw new Error("KZ_LOG_LEVEL is invalid");
		}
		this.logLevel = level;
	}

	private required(environment: $Environment, name: string) {
		const value = environment[name];
		if (!value) throw new Error(`${name} is required`);
		return value;
	}

	private url(environment: $Environment, name: string, protocols: string[]) {
		const value = this.required(environment, name);
		try {
			const parsed = new URL(value);
			if (
				value.trim() !== value ||
				!protocols.includes(parsed.protocol) ||
				!parsed.hostname ||
				parsed.hash
			) {
				throw new Error("Invalid URL");
			}
		} catch {
			throw new Error(`${name} must be a supported connection URL`);
		}
		return value;
	}

	private integer(
		environment: $Environment,
		name: string,
		fallback: number,
		maximum: number,
	) {
		const value = environment[name];
		if (value === undefined) return fallback;
		if (
			!/^[1-9][0-9]*$/.test(value) ||
			!Number.isSafeInteger(Number(value)) ||
			Number(value) > maximum
		) {
			throw new Error(`${name} must be an integer from 1 to ${maximum}`);
		}
		return Number(value);
	}

	private list(value: string | undefined) {
		if (value === undefined || value === "") return [];
		const values = value.split(",").map((item) => item.trim());
		if (values.some((item) => !item))
			throw new Error("Configuration list contains an empty entry");
		return values;
	}
}
