import { RedisClient } from "bun";
import { Database } from "../database/Database.ts";
import type { Config } from "../shared/Config.ts";
import { createLogger } from "../shared/logging.ts";
import { CustomerRepository } from "../customers/CustomerRepository.ts";
import { CustomerService } from "../customers/CustomerService.ts";
import { LicenseRepository } from "../licenses/LicenseRepository.ts";
import { LicenseService } from "../licenses/LicenseService.ts";
import { LicensePolicy } from "../licenses/LicensePolicy.ts";
import { AccessRepository } from "../access/AccessRepository.ts";
import { AccessService } from "../access/AccessService.ts";
import { SessionRepository } from "../sessions/SessionRepository.ts";
import { SessionService } from "../sessions/SessionService.ts";
import { MeterRepository } from "../meters/MeterRepository.ts";
import { MeterService } from "../meters/MeterService.ts";
import { ActivityRepository } from "../activity/ActivityRepository.ts";
import { ActivityService } from "../activity/ActivityService.ts";

export class Services {
	readonly database;
	readonly redis;
	readonly logger = createLogger();
	readonly customers;
	readonly licenses;
	readonly access;
	readonly sessions;
	readonly meters;
	readonly activity;
	constructor(config: Config) {
		this.database = new Database(config.databaseUrl);
		this.redis = new RedisClient(config.redisUrl, {
			connectionTimeout: 3000,
			idleTimeout: 5000,
			enableOfflineQueue: false,
			autoReconnect: true,
			maxRetries: 20,
		});
		const activity = new ActivityRepository(this.database.orm);
		const licenses = new LicenseRepository(this.database);
		const access = new AccessRepository(this.database.orm);
		const meters = new MeterRepository(this.database.orm);
		const policy = new LicensePolicy();
		this.customers = new CustomerService(
			this.database,
			new CustomerRepository(this.database.orm),
			activity,
		);
		this.licenses = new LicenseService(
			this.database,
			licenses,
			policy,
			activity,
			meters,
		);
		this.access = new AccessService(this.database, access, licenses, activity);
		this.sessions = new SessionService(
			this.database,
			new SessionRepository(this.redis),
			licenses,
			policy,
			access,
			activity,
			config.sessionTtl,
			this.logger,
		);
		this.meters = new MeterService(this.database, meters, licenses, activity);
		this.activity = new ActivityService(activity, config.retentionDays);
	}
	async connect() {
		await this.redis.connect();
		await this.database.ping();
	}
	async close() {
		this.redis.close();
		await this.database.close();
	}
}
