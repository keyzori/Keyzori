import { isIP } from "node:net";
import type { Database, Executor } from "../database/Database.ts";
import type { LicenseRepository } from "../licenses/LicenseRepository.ts";
import { publicLicense } from "../licenses/LicenseRepository.ts";
import type { ActivityRepository } from "../activity/ActivityRepository.ts";
import type { AccessRepository } from "./AccessRepository.ts";
import type { allowlistBody, policyBody } from "./schemas.ts";
import { collection, pagination, type pageQuery } from "../shared/schemas.ts";
import { digest, redact } from "../shared/security.ts";
import { normalizeIp } from "../shared/ClientIp.ts";
import { AppError, required } from "../shared/errors.ts";

export class AccessService {
	constructor(
		private readonly database: Database,
		private readonly repository: AccessRepository,
		private readonly licenses: LicenseRepository,
		private readonly activity: ActivityRepository,
	) {}
	async get(id: string) {
		return {
			license: publicLicense(required(await this.licenses.get(id), "License")),
			allowlists: await this.repository.allowlists(id),
		};
	}
	async policy(id: string, input: typeof policyBody.infer) {
		return this.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, id);
			const row = await this.licenses.update(tx, id, input);
			await this.activity.write(tx, "access.policy_changed", id);
			return publicLicense(row);
		});
	}
	async block(id: string, reason: string | null) {
		return this.database.orm.transaction((tx) =>
			this.setBlock(tx, id, "manual", reason),
		);
	}
	// Source-specific writes preserve other sources; plugins pass their own name.
	async setBlock(
		tx: Executor,
		id: string,
		source: string,
		reason: string | null,
	) {
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(source))
			throw new AppError("INVALID_SOURCE", "Invalid block source.");
		await this.licenses.lock(tx, id);
		await this.repository.block(
			tx,
			id,
			source,
			reason === null ? null : String(redact(reason)).slice(0, 500),
		);
		await this.licenses.update(tx, id, {});
		await this.activity.write(
			tx,
			reason === null ? "access.restored" : "access.blocked",
			id,
			undefined,
			source,
		);
		return publicLicense(required(await this.licenses.get(id, tx)));
	}
	async allowlists(id: string, input: typeof allowlistBody.infer) {
		const fingerprints = input.devices.map((device) => {
			if (!device.trim() || device.length > 256)
				throw new AppError(
					"INVALID_DEVICE",
					"Device identifiers must contain 1–256 characters.",
				);
			return digest(device);
		});
		const networks = input.networks.map((network) => {
			const parts = network.split("/");
			const ip = normalizeIp(parts[0] ?? "");
			const max = isIP(ip) === 4 ? 32 : 128;
			const bits = parts[1] === undefined ? max : Number(parts[1]);
			if (
				parts.length > 2 ||
				!Number.isInteger(bits) ||
				bits < 0 ||
				bits > max ||
				(parts[1] !== undefined && !/^\d+$/.test(parts[1]))
			)
				throw new AppError("INVALID_NETWORK", "Invalid CIDR prefix.");
			return `${ip}/${bits}`;
		});
		return this.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, id);
			await this.repository.replaceAllowlists(tx, id, fingerprints, networks);
			await this.licenses.update(tx, id, {});
			await this.activity.write(tx, "access.allowlists_changed", id);
			return this.repository.allowlists(id, tx);
		});
	}
	async devices(id: string, query: typeof pageQuery.infer) {
		required(await this.licenses.get(id), "License");
		const page = pagination(query);
		return collection(await this.repository.listDevices(id, page), page);
	}
	async ips(id: string, query: typeof pageQuery.infer) {
		required(await this.licenses.get(id), "License");
		const page = pagination(query);
		return collection(await this.repository.listIps(id, page), page);
	}
	async registration(
		id: string,
		registrationId: string,
		kind: "device" | "ip",
		blocked: boolean | null,
	) {
		return this.database.orm.transaction(async (tx) => {
			await this.licenses.lock(tx, id);
			const row =
				kind === "device"
					? await this.repository.device(tx, id, registrationId, blocked)
					: await this.repository.ip(tx, id, registrationId, blocked);
			await this.licenses.update(tx, id, {});
			await this.activity.write(tx, `access.${kind}_changed`, id);
			return row;
		});
	}
}
