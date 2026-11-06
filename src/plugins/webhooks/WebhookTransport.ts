import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as requestHttps, type RequestOptions } from "node:https";
import {
	request as requestHttp,
	type ClientRequest,
	type IncomingMessage,
} from "node:http";
import { checkServerIdentity } from "node:tls";
import { HttpError } from "../../core/http/HttpError";

const reserved = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	reserved.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	reserved.addSubnet(address, prefix, "ipv6");

export function publicWebhookAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return !reserved.check(address, "ipv4");
	return (
		family === 6 &&
		globalV6.check(address, "ipv6") &&
		!reserved.check(address, "ipv6")
	);
}

export type $WebhookTransportResult = {
	status: number;
	retryAfter: string | null;
};

export type $WebhookPrivateDestination = { origin: string; cidrs: string[] };

function subnet(cidr: string) {
	if (cidr.length > 80)
		throw new Error("Invalid webhook private destination CIDR");
	const [address, prefixText, extra] = cidr.split("/");
	const family = address ? isIP(address) : 0;
	if (
		/[\s%]/u.test(cidr) ||
		!address ||
		!family ||
		extra !== undefined ||
		!prefixText ||
		!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)
	)
		throw new Error("Invalid webhook private destination CIDR");
	const prefix = Number(prefixText);
	if (prefix > (family === 4 ? 32 : 128))
		throw new Error("Invalid webhook private destination CIDR prefix");
	return {
		address,
		prefix,
		family: family === 4 ? ("ipv4" as const) : ("ipv6" as const),
	};
}

/** Native canonicalization avoids IPv6 arithmetic and mapped-socket differences across OSes. */
function connectionAddress(address: string) {
	if (isIP(address) !== 6) return address;
	const native = new BlockList();
	native.addAddress(address, "ipv6");
	const mapped = native.rules[0]?.match(
		/^Address: IPv6 ::ffff:([0-9.]+)$/,
	)?.[1];
	return mapped && isIP(mapped) === 4 ? mapped : address;
}

/** Operator-only configuration. Native BlockList handles IPv4-mapped IPv6 equivalence. */
export function parseWebhookPrivateDestinations(
	value: unknown,
): $WebhookPrivateDestination[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 32)
		throw new Error(
			"Webhook private destinations must be an array of at most 32 entries",
		);
	const origins = new Set<string>();
	return value.map((entry: unknown) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			Object.keys(entry).some((key) => key !== "origin" && key !== "cidrs") ||
			!("origin" in entry) ||
			typeof entry.origin !== "string" ||
			!("cidrs" in entry) ||
			!Array.isArray(entry.cidrs) ||
			entry.cidrs.length < 1 ||
			entry.cidrs.length > 32
		)
			throw new Error(
				"Each webhook private destination needs an origin and 1 to 32 CIDRs",
			);
		let url: URL;
		try {
			url = new URL(entry.origin);
		} catch {
			throw new Error("Invalid webhook private destination origin");
		}
		if (
			entry.origin.length > 2048 ||
			/[\s\\]/u.test(entry.origin) ||
			!/^https?:\/\/[^/?#]+$/i.test(entry.origin) ||
			!url.hostname ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			origins.has(url.origin)
		)
			throw new Error(
				"Webhook private destinations require unique HTTP(S) origins without credentials, paths, queries or fragments",
			);
		origins.add(url.origin);
		const block = new BlockList();
		const cidrs = entry.cidrs.map((cidr: unknown) => {
			if (typeof cidr !== "string")
				throw new Error("Invalid webhook private destination CIDR");
			const { address, prefix, family } = subnet(cidr);
			block.addSubnet(address, prefix, family);
			return cidr;
		});
		return { origin: url.origin, cidrs };
	});
}

export class WebhookTransport {
	private readonly privateDestinations = new Map<string, BlockList>();
	constructor(
		private readonly allowedOrigins: readonly string[] = [],
		private readonly resolve: (host: string) => Promise<LookupAddress[]> = (
			host,
		) => lookup(host, { all: true, verbatim: true }),
		private readonly connect: (
			options: RequestOptions,
			callback: (response: IncomingMessage) => void,
		) => ClientRequest = (options, callback) =>
			options.protocol === "http:"
				? requestHttp(options, callback)
				: requestHttps(options, callback),
		privateDestinations: readonly $WebhookPrivateDestination[] = [],
	) {
		for (const destination of parseWebhookPrivateDestinations(
			privateDestinations,
		)) {
			const block = new BlockList();
			for (const cidr of destination.cidrs) {
				const { address, prefix, family } = subnet(cidr);
				block.addSubnet(address, prefix, family);
			}
			this.privateDestinations.set(destination.origin, block);
		}
	}
	private addressAllowed(origin: string, address: string) {
		const family = isIP(address);
		if (!family || address.includes("%")) return false;
		const exception = this.privateDestinations.get(origin);
		return exception
			? exception.check(address, family === 4 ? "ipv4" : "ipv6")
			: publicWebhookAddress(address);
	}
	url(value: string) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new HttpError("INVALID_REQUEST");
		}
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (
			value.length > 2048 ||
			/[\s\\]/u.test(value) ||
			(url.protocol !== "https:" &&
				!(
					url.protocol === "http:" && this.privateDestinations.has(url.origin)
				)) ||
			!host ||
			url.username ||
			url.password ||
			url.hash ||
			(isIP(host) !== 0 && !this.addressAllowed(url.origin, host)) ||
			(this.allowedOrigins.length > 0 &&
				!this.allowedOrigins.includes(url.origin))
		)
			throw new HttpError("INVALID_REQUEST", {
				url: "A permitted HTTPS destination or explicit operator exception is required",
			});
		return url;
	}

	/** Pin the actual TCP target; preserve Host and, for HTTPS, SNI and certificate identity. */
	async send(
		value: string,
		body: string,
		headers: Record<string, string>,
		timeoutMs: number,
		cancellation?: AbortSignal,
	): Promise<$WebhookTransportResult> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
			throw new RangeError("Webhook timeout must be between 1 and 120000ms");
		const timeout = new AbortController();
		const timer = setTimeout(
			() => timeout.abort(new Error("Webhook timeout")),
			timeoutMs,
		);
		const signal = cancellation
			? AbortSignal.any([timeout.signal, cancellation])
			: timeout.signal;
		try {
			return await this.request(value, body, headers, signal);
		} finally {
			clearTimeout(timer);
		}
	}
	private async request(
		value: string,
		body: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<$WebhookTransportResult> {
		const url = this.url(value);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		signal.throwIfAborted();
		const addresses = isIP(host)
			? [{ address: host, family: isIP(host) }]
			: await new Promise<{ address: string; family: number }[]>(
					(resolve, reject) => {
						const aborted = () => reject(signal.reason);
						signal.addEventListener("abort", aborted, { once: true });
						void this.resolve(host)
							.then(resolve, reject)
							.finally(() => signal.removeEventListener("abort", aborted));
					},
				);
		if (
			!addresses.length ||
			addresses.length > 32 ||
			addresses.some(
				(entry) =>
					!this.addressAllowed(url.origin, entry.address) ||
					isIP(entry.address) !== entry.family,
			)
		)
			throw new HttpError("FORBIDDEN");
		const selected = addresses[0];
		signal.throwIfAborted();
		if (!selected) throw new HttpError("FORBIDDEN");
		const target = connectionAddress(selected.address);
		if (!this.addressAllowed(url.origin, target))
			throw new HttpError("FORBIDDEN");
		return new Promise((resolve, reject) => {
			const outbound = this.connect(
				{
					protocol: url.protocol,
					hostname: target,
					family: isIP(target),
					port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
					path: `${url.pathname}${url.search}`,
					method: "POST",
					agent: false,
					servername: isIP(host) ? undefined : host,
					checkServerIdentity: (_name, certificate) =>
						checkServerIdentity(host, certificate),
					rejectUnauthorized: true,
					signal,
					maxHeaderSize: 16384,
					headers: {
						...headers,
						host: url.host,
						"content-type": "application/json",
						"content-length": String(Buffer.byteLength(body)),
					},
				},
				(response) => {
					const retryAfter = response.headers["retry-after"];
					resolve({
						status: response.statusCode ?? 0,
						retryAfter: typeof retryAfter === "string" ? retryAfter : null,
					});
					response.destroy();
				},
			);
			outbound.once("error", reject);
			outbound.end(body);
		});
	}
}
