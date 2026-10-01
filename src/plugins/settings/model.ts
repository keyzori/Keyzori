import { t } from "elysia";
import { securityModel } from "../../core/security/model";

const value = t.Object(
	{
		rateLimitEnabled: t.Boolean(),
		validateRequestsPerMinute: t.Integer({ minimum: 1, maximum: 2147483647 }),
		adminRequestsPerMinute: t.Integer({ minimum: 1, maximum: 2147483647 }),
		corsOrigins: t.Array(t.String({ minLength: 1, maxLength: 2048 }), {
			maxItems: 256,
			uniqueItems: true,
		}),
		globalFormatEnabled: t.Boolean(),
		globalKeyFormat: securityModel.keyFormat,
		globalDeniedIps: t.Array(t.String({ minLength: 1, maxLength: 64 }), {
			maxItems: 256,
			uniqueItems: true,
		}),
		failureThreshold: t.Integer({ minimum: 1, maximum: 10000 }),
		failureWindowSeconds: t.Integer({ minimum: 1, maximum: 86400 }),
		failureCooldownSeconds: t.Integer({ minimum: 1, maximum: 604800 }),
		idempotencyRetentionSeconds: t.Integer({ minimum: 60, maximum: 31536000 }),
		webhookTimeoutSeconds: t.Integer({ minimum: 1, maximum: 60 }),
		webhookHistoryDays: t.Union([
			t.Integer({ minimum: 1, maximum: 36500 }),
			t.Null(),
		]),
		defaultPageLimit: t.Integer({ minimum: 1, maximum: 2147483647 }),
	},
	{ additionalProperties: false },
);

export const settingsModel = { value, changes: t.Partial(value) };
