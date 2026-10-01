import { Database } from "./database/Database";
import { Redis } from "./redis/Redis";
import { AuthService } from "./auth/AuthService";
import { ClientIpResolver } from "./http/ClientIpResolver";
import { RequestService } from "./http/RequestService";
import { RequestTracker } from "./http/RequestTracker";
import { RateLimiter } from "./http/RateLimiter";
import { Metrics } from "./observability/Metrics";
import { Logger } from "./observability/Logger";
import { KeyGenerator } from "./security/KeyGenerator";
import { IdempotencyService } from "./security/IdempotencyService";
import { ApiKeyService } from "../plugins/api-keys/ApiKeyService";
import { AuditService } from "../plugins/audits/AuditService";
import { FailureAuditService } from "../plugins/audits/FailureAuditService";
import { HealthService } from "../plugins/health/HealthService";
import { ItemService } from "../plugins/items/ItemService";
import { LicenseService } from "../plugins/licenses/LicenseService";
import { LicenseDeletion } from "../plugins/licenses/LicenseDeletion";
import { MeterService } from "../plugins/licenses/MeterService";
import { SettingsService } from "../plugins/settings/SettingsService";
import { UserService } from "../plugins/users/UserService";
import { ValidationService } from "../plugins/validate/ValidationService";
import { EventService } from "../plugins/webhooks/EventService";
import { WebhookService } from "../plugins/webhooks/WebhookService";
import { WebhookDispatcher } from "../plugins/webhooks/WebhookDispatcher";
import type { Config } from "./config/Config";
import { version } from "../version";

export class ServerServices {
	readonly database;
	readonly redis;
	readonly logger;
	readonly metrics = new Metrics();
	readonly tracker;
	readonly auth;
	readonly audit;
	readonly ip;
	readonly settings;
	readonly requests;
	readonly apiKeys;
	readonly health;
	readonly items;
	readonly licenses;
	readonly meters;
	readonly users;
	readonly validation;
	readonly webhooks;
	readonly dispatcher;
	constructor(config: Config) {
		this.database = new Database(
			config.databaseUrl,
			config.poolSize,
			this.metrics,
		);
		this.redis = new Redis(config.redisUrl);

		this.tracker = new RequestTracker(this.metrics);
		this.logger = new Logger(config.logLevel);
		this.auth = new AuthService(this.database, config.masterKey);
		this.audit = new AuditService();
		this.ip = new ClientIpResolver(
			this.database,
			config.trustedProxies,
			config.clientIpHeaders,
		);
		this.settings = new SettingsService(this.database, this.audit, this.ip);
		this.requests = new RequestService(
			this.auth,
			this.ip,
			new RateLimiter(this.redis),
			this.settings,
			this.tracker,
		);
		const idem = new IdempotencyService(this.database, this.settings);
		const events = new EventService();
		this.meters = new MeterService(this.audit, events);
		const deletion = new LicenseDeletion(this.audit, events);
		this.apiKeys = new ApiKeyService(
			this.database,
			this.audit,
			this.settings,
			idem,
		);
		this.health = new HealthService(
			this.database,
			this.redis,
			this.tracker,
			this.metrics,
			version,
		);
		this.items = new ItemService(
			this.database,
			this.auth,
			this.audit,
			events,
			this.settings,
			idem,
			deletion,
			new KeyGenerator(),
		);
		this.licenses = new LicenseService(
			this.database,
			this.auth,
			this.audit,
			events,
			this.settings,
			idem,
			this.meters,
			deletion,
			this.ip,
		);
		this.users = new UserService(
			this.database,
			this.auth,
			this.audit,
			events,
			this.settings,
			idem,
			deletion,
		);
		this.validation = new ValidationService(
			this.database,
			this.redis,
			this.settings,
			this.ip,
			this.meters,
			idem,
			this.audit,
			new FailureAuditService(
				this.database,
				this.redis,
				this.audit,
				events,
				this.settings,
			),
		);
		this.webhooks = new WebhookService(
			this.database,
			this.auth,
			this.audit,
			this.settings,
			idem,
		);
		this.dispatcher = new WebhookDispatcher(
			this.database,
			this.settings,
			this.metrics,
		);
	}
}
