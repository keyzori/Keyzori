import type { Server } from "bun";
import { BlockList, isIP } from "node:net";
import { normalizeIpAddress } from "../domain/ipAddress";

export type TrustedProxyHeader =
	| "x-forwarded-for"
	| "cf-connecting-ip"
	| "x-real-ip"
	| "*";

export interface ClientIpOptions {
	trustProxyHeaders: boolean;
	trustedProxyCidrs: string[];
	trustedProxyHeader?: TrustedProxyHeader;
}

const FALLBACK_IP = "127.0.0.1";
const MAX_FORWARDED_CHAIN_LENGTH = 32;

/** Resolves client addresses without rebuilding trusted CIDR state per request. */
export class ClientIpResolver {
	private readonly trustedProxies = new BlockList();
	private readonly header: TrustedProxyHeader;
	private readonly trustAllProxies: boolean;

	constructor(private readonly options: ClientIpOptions) {
		this.header = options.trustedProxyHeader ?? "x-forwarded-for";
		this.trustAllProxies = options.trustedProxyCidrs.includes("*");
		for (const cidr of options.trustedProxyCidrs) {
			if (cidr === "*") continue;
			const [address, prefixText] = cidr.split("/");
			const family = address ? isIP(address) : 0;
			if (!address || !prefixText || family === 0) continue;
			this.trustedProxies.addSubnet(
				address,
				Number(prefixText),
				family === 4 ? "ipv4" : "ipv6",
			);
		}
	}

	public resolve(request: Request, server: Server<unknown> | null): string {
		const socketIp =
			normalizeIpAddress(server?.requestIP(request)?.address ?? FALLBACK_IP) ??
			FALLBACK_IP;
		if (!this.options.trustProxyHeaders || !this.isTrusted(socketIp)) {
			return socketIp;
		}

		const cloudflare = request.headers.get("cf-connecting-ip");
		const forwarded = request.headers.get("x-forwarded-for");
		const realIp = request.headers.get("x-real-ip");
		if (this.header === "*") {
			const resolved: string[] = [];
			for (const value of [cloudflare, realIp]) {
				if (value === null) continue;
				const normalized = normalizeIpAddress(value);
				if (!normalized) return socketIp;
				resolved.push(normalized);
			}
			if (forwarded !== null) {
				resolved.push(this.resolveForwardedChain(forwarded, socketIp));
			}
			if (resolved.length === 0 || new Set(resolved).size !== 1)
				return socketIp;
			return resolved[0] ?? socketIp;
		}

		if (this.header === "cf-connecting-ip") {
			return normalizeIpAddress(cloudflare ?? "") ?? socketIp;
		}
		if (this.header === "x-real-ip") {
			return normalizeIpAddress(realIp ?? "") ?? socketIp;
		}

		return this.resolveForwardedChain(forwarded, socketIp);
	}

	private resolveForwardedChain(
		forwarded: string | null,
		socketIp: string,
	): string {
		if (!forwarded) return socketIp;
		const chain = forwarded.split(",");
		if (
			chain.length > MAX_FORWARDED_CHAIN_LENGTH ||
			chain.some((entry) => normalizeIpAddress(entry) === null)
		) {
			return socketIp;
		}

		let current = socketIp;
		for (let index = chain.length - 1; index >= 0; index--) {
			if (!this.isTrusted(current)) return current;
			current = normalizeIpAddress(chain[index] ?? "") ?? socketIp;
		}
		return current;
	}

	private isTrusted(address: string): boolean {
		const family = isIP(address);
		return (
			family > 0 &&
			(this.trustAllProxies ||
				this.trustedProxies.check(address, family === 4 ? "ipv4" : "ipv6"))
		);
	}
}

/** Compatibility helper. Long-lived servers should reuse ClientIpResolver. */
export function getClientIp(
	request: Request,
	server: Server<unknown> | null,
	options: ClientIpOptions,
): string {
	return new ClientIpResolver(options).resolve(request, server);
}
