import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { Database } from "../database/Database";
import type { $Transaction } from "../../types/database";
import { HttpError } from "./HttpError";

export class ClientIpResolver {
	constructor(
		private readonly database: Database,
		private readonly trustedProxies: string[] = [],
		private readonly clientIpHeaders: string[] = [],
	) {
		this.validateRules(trustedProxies);
		if (
			clientIpHeaders.some(
				(header) =>
					!["cf-connecting-ip", "x-real-ip", "x-forwarded-for"].includes(
						header,
					),
			)
		) {
			throw new Error("Unsupported client IP header");
		}
	}

	async resolve(peer: string | null, headers: Headers, deadlineAt?: number) {
		if (!peer || !this.isHost(peer)) throw new HttpError("SERVICE_UNAVAILABLE");
		if (this.trustedProxies.length === 0)
			return this.normalize(peer, deadlineAt);
		const candidates = this.clientIpHeaders.map((header) =>
			this.header(header, headers.get(header)),
		);
		const addresses = [
			...new Set([peer, ...candidates.flatMap((candidate) => candidate ?? [])]),
		];
		const rows = await this.database
			.transaction(
				(tx) => this.compare(tx, addresses, this.trustedProxies),
				"read",
				deadlineAt,
			)
			.catch(() => {
				throw new HttpError("SERVICE_UNAVAILABLE");
			});
		const byInput = new Map(rows.map((row) => [row.input, row]));
		const socket = byInput.get(peer);
		if (!socket) throw new HttpError("SERVICE_UNAVAILABLE");
		if (!socket.trusted) return socket.address;
		for (const candidate of candidates) {
			if (!candidate) continue;
			let selected = socket;
			for (
				let index = candidate.length - 1;
				index >= 0 && selected.trusted;
				index--
			) {
				const input = candidate[index];
				const next = input === undefined ? undefined : byInput.get(input);
				if (!next) throw new HttpError("SERVICE_UNAVAILABLE");
				selected = next;
			}
			return selected.address;
		}
		return socket.address;
	}

	async normalize(address: string, deadlineAt?: number) {
		if (!this.isHost(address))
			throw new HttpError("INVALID_REQUEST", { ip: "Invalid IP address" });
		try {
			const [row] = await this.database.transaction(
				(tx) => this.compare(tx, [address], []),
				"read",
				deadlineAt,
			);
			if (!row) throw new Error("Missing IP result");
			return row.address;
		} catch {
			throw new HttpError("SERVICE_UNAVAILABLE");
		}
	}

	validateRules(rules: string[]) {
		for (const rule of rules) {
			const [address, mask, extra] = rule.split("/");
			if (
				!address ||
				!this.isHost(address) ||
				extra !== undefined ||
				(mask !== undefined &&
					(!/^(0|[1-9][0-9]*)$/.test(mask) ||
						Number(mask) > (isIP(address) === 4 ? 32 : 128)))
			) {
				throw new HttpError("INVALID_REQUEST", {
					ips: "Rules must be IP addresses or CIDRs",
				});
			}
		}
	}

	async matches(tx: $Transaction, ip: string, rules: string[]) {
		if (!this.isHost(ip))
			throw new HttpError("INVALID_REQUEST", { ip: "Invalid IP address" });
		this.validateRules(rules);
		const [row] = await this.compare(tx, [ip], rules).catch(() => {
			throw new HttpError("SERVICE_UNAVAILABLE");
		});
		if (!row) throw new HttpError("SERVICE_UNAVAILABLE");
		return row.trusted;
	}

	private isHost(address: string) {
		return !address.includes("%") && isIP(address) !== 0;
	}

	private header(name: string, value: string | null) {
		if (!value) return null;
		if (name !== "x-forwarded-for") return this.isHost(value) ? [value] : null;
		if (value.length > 6144) return null;
		const chain = value.split(",").map((address) => address.trim());
		return chain.length <= 128 && chain.every((address) => this.isHost(address))
			? chain
			: null;
	}

	private async compare(
		tx: $Transaction,
		addresses: string[],
		rules: string[],
	) {
		return tx
			.select({
				input: sql<string>`hosts.input`,
				address: sql<string>`host(hosts.address)`,
				trusted: sql<boolean>`hosts.trusted`,
			})
			.from(sql`(
			with raw as (
				select value as input, value::inet as address, false as is_rule
				from jsonb_array_elements_text(${JSON.stringify(addresses)}::text::jsonb)
				union all
				select value as input, value::inet as address, true as is_rule
				from jsonb_array_elements_text(${JSON.stringify(rules)}::text::jsonb)
			), normalized as (
				select input, is_rule, case when family(address) = 6 then case
					when masklen(address) >= 96
						and set_masklen(address, 128) <<= inet '::ffff:0.0.0.0/96'
					then set_masklen(inet '0.0.0.0' + (set_masklen(address, 128) - inet '::ffff:0.0.0.0'), masklen(address) - 96)
					else address end else address end as address
				from raw
			)
			select hosts.input, hosts.address, exists(select 1 from normalized rules
				where rules.is_rule and hosts.address <<= network(rules.address)) as trusted
			from normalized hosts where not hosts.is_rule
		) as hosts`);
	}
}
