import { isIP } from "node:net";
import type { Config } from "./Config.ts";
import { AppError } from "./errors.ts";

export function normalizeIp(value: string): string {
	const family = isIP(value);
	if (!family || value.includes("%"))
		throw new AppError("INVALID_IP", "A valid IP address is required.");
	if (family === 4) return value;
	const ip = new URL(`http://[${value}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(ip);
	if (!mapped?.[1] || !mapped[2]) return ip;
	const number = (BigInt(`0x${mapped[1]}`) << 16n) | BigInt(`0x${mapped[2]}`);
	return [24n, 16n, 8n, 0n]
		.map((shift) => Number((number >> shift) & 255n))
		.join(".");
}

export class ClientIp {
	constructor(private readonly config: Config) {}
	resolve(request: Request, peer: string | undefined) {
		if (!peer)
			throw new AppError(
				"IP_UNAVAILABLE",
				"Client connection address is unavailable.",
				503,
			);
		let ip = normalizeIp(peer);
		const forwarded = request.headers.get("x-forwarded-for");
		if (!this.trusted(ip) || !forwarded) return ip;
		const chain = forwarded.split(",");
		if (chain.length > 32)
			throw new AppError("INVALID_IP", "Too many forwarded addresses.");
		for (let i = chain.length - 1; i >= 0 && this.trusted(ip); i--)
			ip = normalizeIp(chain[i]?.trim() ?? "");
		return ip;
	}
	private trusted(ip: string) {
		return this.config.trustedProxies.check(
			ip,
			isIP(ip) === 4 ? "ipv4" : "ipv6",
		);
	}
}
