import { TestDatabase } from "./TestDatabase";
import { Redis } from "../../core/redis/Redis";
import { AuthService } from "../../core/auth/AuthService";
import { AuditService } from "../../plugins/audits/AuditService";
import { SettingsService } from "../../plugins/settings/SettingsService";
import { ClientIpResolver } from "../../core/http/ClientIpResolver";
import { IdempotencyService } from "../../core/security/IdempotencyService";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { EventService } from "../../plugins/webhooks/EventService";
import { MeterService } from "../../plugins/licenses/MeterService";
import { LicenseDeletion } from "../../plugins/licenses/LicenseDeletion";
import { LicenseService } from "../../plugins/licenses/LicenseService";
import { ApiKeyService } from "../../plugins/api-keys/ApiKeyService";
import { ValidationService } from "../../plugins/validate/ValidationService";
import { FailureAuditService } from "../../plugins/audits/FailureAuditService";
import type { $Operation } from "../../types/operation";

export class TestContext {
	readonly fixture = new TestDatabase();
	readonly database = this.fixture.database;
	readonly redis;
	readonly master = new KeyGenerator().master();
	readonly auth = new AuthService(this.database, this.master);
	readonly audit = new AuditService();
	readonly ip = new ClientIpResolver(this.database);
	readonly settings = new SettingsService(this.database, this.audit, this.ip);
	readonly idempotency = new IdempotencyService(this.database, this.settings);
	readonly events = new EventService();
	readonly meters = new MeterService(this.audit, this.events);
	readonly deletion = new LicenseDeletion(this.audit, this.events);
	readonly licenses = new LicenseService(
		this.database,
		this.auth,
		this.audit,
		this.events,
		this.settings,
		this.idempotency,
		this.meters,
		this.deletion,
		this.ip,
	);
	readonly apiKeys = new ApiKeyService(
		this.database,
		this.audit,
		this.settings,
		this.idempotency,
	);
	readonly failures;
	readonly validation;
	constructor() {
		const redisUrl = Bun.env.KZ_TEST_REDIS_URL;
		if (!redisUrl) throw new Error("KZ_TEST_REDIS_URL is required");
		this.redis = new Redis(redisUrl);
		this.failures = new FailureAuditService(
			this.database,
			this.redis,
			this.audit,
			this.events,
			this.settings,
		);
		this.validation = new ValidationService(
			this.database,
			this.redis,
			this.settings,
			this.ip,
			this.meters,
			this.idempotency,
			this.audit,
			this.failures,
		);
	}
	operation(): $Operation {
		return {
			principal: { kind: "root", id: "root", name: "Root", scopes: [] },
			clientIp: "127.0.0.1",
			requestId: Bun.randomUUIDv7(),
			idempotencyKey: Bun.randomUUIDv7(),
		};
	}
	async start() {
		await this.fixture.start();
		await this.redis.connect();
	}
	async stop() {
		this.redis.close();
		await this.fixture.stop();
	}
}
