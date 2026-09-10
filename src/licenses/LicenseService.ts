import type { Database } from "../database/Database.ts";
import type { ActivityRepository } from "../activity/ActivityRepository.ts";
import type { LicenseRepository } from "./LicenseRepository.ts";
import { publicLicense } from "./LicenseRepository.ts";
import type { LicensePolicy } from "./LicensePolicy.ts";
import type {
	licenseBody,
	licenseConfig,
	licenseQuery,
	licenseUpdate,
} from "./schemas.ts";
import { collection, pagination } from "../shared/schemas.ts";
import { digest, secret, metadata } from "../shared/security.ts";
import { AppError, required } from "../shared/errors.ts";
import type { MeterRepository } from "../meters/MeterRepository.ts";

export class LicenseService {
	constructor(
		private readonly database: Database,
		private readonly repository: LicenseRepository,
		private readonly policy: LicensePolicy,
		private readonly activity: ActivityRepository,
		private readonly meters: MeterRepository,
	) {}
	async get(id: string) {
		return publicLicense(required(await this.repository.get(id), "License"));
	}
	async list(query: typeof licenseQuery.infer) {
		const page = pagination(query);
		return collection(
			(await this.repository.list(query, page)).map(publicLicense),
			page,
		);
	}
	async create(input: typeof licenseBody.infer) {
		this.policy.validateConfig(input.config);
		const key = secret("lic");
		return this.database.orm.transaction(async (tx) => {
			const row = await this.repository.create(tx, {
				customerId: input.customerId,
				type: input.config.type,
				keyHash: digest(key),
				metadata: metadata(input.metadata),
			});
			await this.repository.replaceConfig(tx, row.id, input.config);
			await this.activity.write(tx, "license.created", row.id);
			return {
				...publicLicense(required(await this.repository.get(row.id, tx))),
				key,
			};
		});
	}
	async update(id: string, input: typeof licenseUpdate.infer) {
		return this.database.orm.transaction(async (tx) => {
			await this.repository.lock(tx, id);
			const row = await this.repository.update(tx, id, {
				...input,
				...(input.metadata ? { metadata: metadata(input.metadata) } : {}),
			});
			await this.activity.write(tx, "license.updated", id);
			return publicLicense(row);
		});
	}
	async changeType(id: string, config: typeof licenseConfig.infer) {
		this.policy.validateConfig(config);
		return this.database.orm.transaction(async (tx) => {
			const old = await this.repository.lock(tx, id);
			// Usage history must survive a type change; meters remain historical and
			// cannot be consumed unless the current type is metered.
			if (old.type !== "metered" && config.type === "metered")
				await this.meters.reset(tx, id);
			await this.repository.replaceConfig(tx, id, config);
			await this.repository.update(tx, id, { type: config.type });
			await this.activity.write(tx, "license.type_changed", id);
			return publicLicense(required(await this.repository.get(id, tx)));
		});
	}
	async renew(id: string, expiresAt: string) {
		this.policy.validateConfig({ type: "subscription", expiresAt });
		return this.database.orm.transaction(async (tx) => {
			await this.repository.lock(tx, id);
			const license = required(await this.repository.get(id, tx));
			if (license.type !== "subscription" || !license.subscription)
				throw new AppError(
					"INVALID_TYPE",
					"Only subscriptions can be renewed.",
				);
			if (new Date(expiresAt) <= license.subscription.expiresAt)
				throw new AppError(
					"INVALID_EXPIRY",
					"Renewal must extend the current expiry.",
				);
			await this.repository.renew(tx, id, new Date(expiresAt));
			await this.repository.update(tx, id, {});
			await this.activity.write(tx, "license.renewed", id);
			return publicLicense(required(await this.repository.get(id, tx)));
		});
	}
	async rotate(id: string) {
		const key = secret("lic");
		return this.database.orm.transaction(async (tx) => {
			await this.repository.lock(tx, id);
			const row = await this.repository.update(tx, id, {
				keyHash: digest(key),
			});
			await this.activity.write(tx, "license.key_rotated", id);
			return { ...publicLicense(row), key };
		});
	}
}
