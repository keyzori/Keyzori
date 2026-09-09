import type {
	ActivityEvent,
	ActivityEventType,
	ActivityMinuteBucket,
	ActivityTotal,
	NewActivityEvent,
} from "../entities";

export interface ActivityQuery {
	licenseId?: string;
	customerId?: string;
	type?: ActivityEventType;
	from?: Date;
	to?: Date;
	limit?: number;
}

export interface ActivityStatistics {
	totals: ActivityTotal[];
	buckets: ActivityMinuteBucket[];
	recent: ActivityEvent[];
}

export interface IActivityRepository {
	record(event: NewActivityEvent): Promise<ActivityEvent>;
	listDetailed(query?: ActivityQuery): Promise<ActivityEvent[]>;
	getStatistics(query?: ActivityQuery): Promise<ActivityStatistics>;
	pruneBefore(before: Date): Promise<number>;
}

export const noopActivityRepository: IActivityRepository = {
	record: async (event) => ({
		id: crypto.randomUUID(),
		type: event.type,
		source: event.source,
		outcome: event.outcome ?? "success",
		reason: event.reason ?? null,
		licenseId: event.licenseId ?? null,
		customerId: event.customerId ?? null,
		keyPrefix: event.keyPrefix ?? null,
		ip: event.ip ?? null,
		deviceId: event.deviceId ?? null,
		details: event.details ?? {},
		createdAt: event.createdAt ?? new Date(),
	}),
	listDetailed: async () => [],
	getStatistics: async () => ({ totals: [], buckets: [], recent: [] }),
	pruneBefore: async () => 0,
};
