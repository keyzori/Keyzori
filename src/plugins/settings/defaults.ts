import { KeyGenerator } from "../../core/security/KeyGenerator";
import type { $Settings } from "../../types/settings";

export const settingsDefaults: $Settings = {
	rateLimitEnabled: true,
	validateRequestsPerMinute: 120,
	adminRequestsPerMinute: 300,
	corsOrigins: [],
	globalFormatEnabled: true,
	globalKeyFormat: KeyGenerator.defaultFormat,
	globalDeniedIps: [],
	failureThreshold: 5,
	failureWindowSeconds: 900,
	failureCooldownSeconds: 900,
	idempotencyRetentionSeconds: 86400,
	webhookTimeoutSeconds: 10,
	webhookHistoryDays: 30,
	defaultPageLimit: 10,
};
