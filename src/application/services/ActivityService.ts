import type {
	ActivityEvent,
	JsonObject,
	JsonValue,
	NewActivityEvent,
} from "../../domain/entities";
import type {
	ActivityQuery,
	ActivityStatistics,
	IActivityRepository,
} from "../../domain/repositories/IActivityRepository";

export type ActivityErrorReporter = (message: string, error: unknown) => void;

export interface ActivityRecorder {
	capture(input: NewActivityEvent): Promise<ActivityEvent | null>;
}

const SENSITIVE_DETAIL_KEY =
	/(?:license.?key|api.?key|secret|token|authorization|password)/i;
const SENSITIVE_DETAIL_VALUE =
	/(?:^|[^A-Za-z0-9])(?:lic_|sk_|whsec_|Bearer\s+)\S*/i;
const UUID_DETAIL_VALUE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (value && typeof value === "object") return sanitizeDetails(value);
	if (
		typeof value === "string" &&
		(SENSITIVE_DETAIL_VALUE.test(value) || UUID_DETAIL_VALUE.test(value))
	) {
		return "[REDACTED]";
	}
	return value;
}

function sanitizeReason(reason: string | null | undefined): string | null {
	if (!reason) return reason ?? null;
	return SENSITIVE_DETAIL_VALUE.test(reason) || UUID_DETAIL_VALUE.test(reason)
		? "[REDACTED]"
		: reason;
}

export function sanitizeDetails(details: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(details)
			.filter(([key]) => !SENSITIVE_DETAIL_KEY.test(key))
			.map(([key, value]) => [key, sanitizeValue(value)]),
	);
}

export class ActivityService implements ActivityRecorder {
	constructor(
		private readonly repository: IActivityRepository,
		private readonly reportError: ActivityErrorReporter = (message, error) =>
			console.error(message, error),
	) {}

	/** Persist without allowing telemetry failure to affect licensing. */
	async capture(input: NewActivityEvent): Promise<ActivityEvent | null> {
		const sanitized: NewActivityEvent = {
			...input,
			reason: sanitizeReason(input.reason),
			keyPrefix: input.keyPrefix?.slice(0, 16) ?? null,
			details: sanitizeDetails(input.details ?? {}),
		};
		try {
			return await this.repository.record(sanitized);
		} catch (error) {
			this.reportError("Activity persistence failed", error);
			return null;
		}
	}

	async listDetailed(query?: ActivityQuery): Promise<ActivityEvent[]> {
		return await this.repository.listDetailed(query);
	}

	async getStatistics(query?: ActivityQuery): Promise<ActivityStatistics> {
		return await this.repository.getStatistics(query);
	}

	async pruneExpiredActivity(
		retentionDays = 30,
		now = new Date(),
	): Promise<number> {
		if (!Number.isInteger(retentionDays) || retentionDays < 1) {
			throw new Error("Activity retention days must be a positive integer.");
		}
		return await this.repository.pruneBefore(
			new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000),
		);
	}
}

export const noopActivityRecorder: ActivityRecorder = {
	capture: async () => null,
};
