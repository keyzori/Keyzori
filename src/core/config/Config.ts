import { isIP } from "node:net";
import type { $Environment } from "../../types/config";
import {
	maintenanceDefaults,
	type MaintenanceBudgets,
} from "../MaintenanceService";
import {
	parseWebhookPrivateDestinations,
	type $WebhookPrivateDestination,
} from "../../plugins/webhooks/WebhookTransport";

export class Config {
	/** Reads only database settings, so migration jobs need no API or Redis secrets. */
	static database(environment: $Environment = Bun.env, migration = false) {
		const name =
			migration && environment.KZ_MIGRATION_DATABASE_URL
				? "KZ_MIGRATION_DATABASE_URL"
				: "KZ_DATABASE_URL";
		return {
			databaseUrl: Config.url(environment, name, ["postgres:", "postgresql:"]),
			poolSize: Config.integer(environment, "KZ_DATABASE_POOL_SIZE", 10, 1000),
		};
	}
	readonly databaseUrl;
	readonly redisUrl;
	readonly masterKey;
	readonly host: string;
	readonly port;
	readonly poolSize;
	readonly trustedProxies;
	readonly clientIpHeaders;
	readonly logLevel: "debug" | "info" | "warn" | "error";
	readonly webhookEncryptionKey: string | undefined;
	readonly webhookAllowedOrigins: string[];
	readonly webhookPrivateDestinations: $WebhookPrivateDestination[];
	readonly streamOrigins: string[];
	readonly maxInFlight: number;
	readonly peerRequestsPerMinute: number;
	readonly maxStreams: number;
	readonly maintenance: MaintenanceBudgets;
	readonly eventRetentionDays: number | null;

	constructor(environment: $Environment = Bun.env) {
		this.databaseUrl = Config.database(environment).databaseUrl;
		this.redisUrl = Config.url(environment, "KZ_REDIS_URL", [
			"redis:",
			"rediss:",
		]);
		this.masterKey = Config.required(environment, "KZ_MASTER_KEY");
		if (!/^kz_key_[a-fA-F0-9]{64}$/.test(this.masterKey)) {
			throw new Error(
				"KZ_MASTER_KEY must use kz_key_ followed by 64 hexadecimal characters",
			);
		}
		this.host = environment.KZ_API_HOST ?? "0.0.0.0";
		if (!isIP(this.host) || this.host.includes("%"))
			throw new Error("KZ_API_HOST must be an IP address");
		this.port = Config.integer(environment, "KZ_API_PORT", 6284, 65535);
		this.poolSize = Config.integer(
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
		this.webhookEncryptionKey =
			environment.KZ_WEBHOOK_ENCRYPTION_KEY || undefined;
		if (
			this.webhookEncryptionKey &&
			!/^[a-fA-F0-9]{64}$/.test(this.webhookEncryptionKey)
		)
			throw new Error(
				"KZ_WEBHOOK_ENCRYPTION_KEY must contain 64 hexadecimal characters",
			);
		try {
			const value = environment.KZ_WEBHOOK_PRIVATE_DESTINATIONS;
			if (value && Buffer.byteLength(value) > 65536)
				throw new Error("Configuration exceeds budget");
			this.webhookPrivateDestinations = parseWebhookPrivateDestinations(
				value ? JSON.parse(value) : undefined,
			);
		} catch {
			throw new Error(
				"KZ_WEBHOOK_PRIVATE_DESTINATIONS must be bounded JSON origin/CIDR rules",
			);
		}
		this.webhookAllowedOrigins = this.origins(
			environment.KZ_WEBHOOK_ALLOWED_ORIGINS,
			"KZ_WEBHOOK_ALLOWED_ORIGINS",
			["https:", "http:"],
		);
		if (
			this.webhookAllowedOrigins.some(
				(origin) =>
					origin.startsWith("http:") &&
					!this.webhookPrivateDestinations.some(
						(rule) => rule.origin === origin,
					),
			)
		)
			throw new Error(
				"KZ_WEBHOOK_ALLOWED_ORIGINS HTTP origins require an explicit private-destination rule",
			);
		this.streamOrigins = this.origins(
			environment.KZ_STREAM_ORIGINS,
			"KZ_STREAM_ORIGINS",
			["https:", "http:"],
		);
		this.maxInFlight = Config.integer(
			environment,
			"KZ_MAX_IN_FLIGHT",
			128,
			4096,
		);
		this.peerRequestsPerMinute = Config.integer(
			environment,
			"KZ_PEER_REQUESTS_PER_MINUTE",
			600,
			100000,
		);
		this.maxStreams = Config.integer(environment, "KZ_MAX_STREAMS", 100, 10000);
		this.maintenance = {
			resetRows: Config.integer(
				environment,
				"KZ_MAINTENANCE_RESET_ROWS",
				maintenanceDefaults.resetRows,
				10000,
			),
			resetTimeMs: Config.integer(
				environment,
				"KZ_MAINTENANCE_RESET_TIME_MS",
				maintenanceDefaults.resetTimeMs,
				60000,
			),
			cleanupRows: Config.integer(
				environment,
				"KZ_MAINTENANCE_CLEANUP_ROWS",
				maintenanceDefaults.cleanupRows,
				10000,
			),
			cleanupTimeMs: Config.integer(
				environment,
				"KZ_MAINTENANCE_CLEANUP_TIME_MS",
				maintenanceDefaults.cleanupTimeMs,
				60000,
			),
			observationTimeMs: Config.integer(
				environment,
				"KZ_MAINTENANCE_OBSERVATION_TIME_MS",
				maintenanceDefaults.observationTimeMs,
				60000,
			),
			retryBaseMs: Config.integer(
				environment,
				"KZ_MAINTENANCE_RETRY_BASE_MS",
				maintenanceDefaults.retryBaseMs,
				86400000,
			),
			retryMaxMs: Config.integer(
				environment,
				"KZ_MAINTENANCE_RETRY_MAX_MS",
				maintenanceDefaults.retryMaxMs,
				86400000,
			),
		};
		if (this.maintenance.retryMaxMs < this.maintenance.retryBaseMs)
			throw new Error(
				"KZ_MAINTENANCE_RETRY_MAX_MS must be at least KZ_MAINTENANCE_RETRY_BASE_MS",
			);
		this.eventRetentionDays = environment.KZ_EVENT_RETENTION_DAYS
			? Config.integer(environment, "KZ_EVENT_RETENTION_DAYS", 7, 3650)
			: null;
	}
	private origins(
		value: string | undefined,
		name: string,
		protocols: string[],
	) {
		const origins = this.list(value);
		for (const origin of origins) {
			try {
				const parsed = new URL(origin);
				if (
					!protocols.includes(parsed.protocol) ||
					parsed.origin !== origin ||
					parsed.username ||
					parsed.password
				)
					throw new Error("Invalid origin");
			} catch {
				throw new Error(
					`${name} must contain exact allowed origins without paths or credentials`,
				);
			}
		}
		return [...new Set(origins)];
	}

	private static required(environment: $Environment, name: string) {
		const value = environment[name];
		if (!value) throw new Error(`${name} is required`);
		return value;
	}

	private static url(
		environment: $Environment,
		name: string,
		protocols: string[],
	) {
		const value = Config.required(environment, name);
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

	private static integer(
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
