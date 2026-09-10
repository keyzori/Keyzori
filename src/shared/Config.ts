import { BlockList, isIP } from "node:net";

export type Environment = Record<string, string | undefined>;
export class Config {
	readonly adminKey: string;
	readonly databaseUrl: string;
	readonly redisUrl: string;
	readonly port: number;
	readonly host: string;
	readonly sessionTtl: number;
	readonly retentionDays: number;
	readonly rateLimit: number;
	readonly plugins: string[];
	readonly trustedProxies = new BlockList();
	constructor(readonly env: Environment) {
		this.adminKey = this.required("KEYZORI_ADMIN_KEY");
		if (this.adminKey.length < 32)
			throw new Error("KEYZORI_ADMIN_KEY must contain at least 32 characters.");
		this.databaseUrl = this.url("KEYZORI_DATABASE_URL", [
			"postgres:",
			"postgresql:",
		]);
		this.redisUrl = this.url("KEYZORI_REDIS_URL", ["redis:", "rediss:"]);
		this.port = this.integer("KEYZORI_PORT", 3000, 0, 65535);
		this.host = env.KEYZORI_HOST ?? "0.0.0.0";
		this.sessionTtl = this.integer("KEYZORI_SESSION_TTL", 60, 5, 3600);
		this.retentionDays = this.integer(
			"KEYZORI_ACTIVITY_RETENTION_DAYS",
			30,
			1,
			3650,
		);
		this.rateLimit = this.integer("KEYZORI_RATE_LIMIT", 120, 1, 100000);
		this.plugins = (env.KEYZORI_PLUGINS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.sort();
		if (
			new Set(this.plugins).size !== this.plugins.length ||
			this.plugins.some((s) => !/^[a-z][a-z0-9-]{0,63}$/.test(s))
		)
			throw new Error("KEYZORI_PLUGINS contains duplicate or invalid names.");
		for (const entry of (env.KEYZORI_TRUSTED_PROXIES ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			const parts = entry.split("/");
			const [ip, prefix] = parts;
			const family = ip && isIP(ip);
			if (!ip || !family || ip.includes("%"))
				throw new Error("Invalid trusted proxy address.");
			if (parts.length > 2 || (prefix !== undefined && !/^\d+$/.test(prefix)))
				throw new Error("Invalid trusted proxy prefix.");
			const bits =
				prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
			if (
				!Number.isInteger(bits) ||
				bits < 0 ||
				bits > (family === 4 ? 32 : 128)
			)
				throw new Error("Invalid trusted proxy prefix.");
			this.trustedProxies.addSubnet(ip, bits, family === 4 ? "ipv4" : "ipv6");
		}
	}
	private required(name: string) {
		const value = this.env[name];
		if (!value?.trim()) throw new Error(`${name} is required.`);
		return value;
	}
	private url(name: string, protocols: string[]) {
		const value = this.required(name);
		try {
			if (protocols.includes(new URL(value).protocol)) return value;
		} catch {
			/* sanitized below */
		}
		throw new Error(`${name} has an invalid URL.`);
	}
	private integer(name: string, fallback: number, min: number, max: number) {
		const raw = this.env[name];
		const value =
			raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
		if (!Number.isSafeInteger(value) || value < min || value > max)
			throw new Error(`${name} must be an integer from ${min} to ${max}.`);
		return value;
	}
}
