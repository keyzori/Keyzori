import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type {
	ActivityEvent,
	ActivityScope,
	NewActivityEvent,
} from "../../domain/entities";
import type {
	ActivityQuery,
	ActivityStatistics,
	IActivityRepository,
} from "../../domain/repositories/IActivityRepository";
import type { Database } from "../../db";
import {
	activityEvents,
	activityMinuteBuckets,
	activityTotals,
} from "../../db/schema";

function scopesForEvent(event: NewActivityEvent): Array<{
	scope: ActivityScope;
	scopeId: string;
}> {
	const scopes: Array<{ scope: ActivityScope; scopeId: string }> = [
		{ scope: "global", scopeId: "" },
	];
	if (event.customerId) {
		scopes.push({ scope: "customer", scopeId: event.customerId });
	}
	if (event.licenseId) {
		scopes.push({ scope: "license", scopeId: event.licenseId });
	}
	return scopes;
}

function queryScope(query: ActivityQuery): {
	scope: ActivityScope;
	scopeId: string;
} {
	if (query.licenseId) return { scope: "license", scopeId: query.licenseId };
	if (query.customerId) return { scope: "customer", scopeId: query.customerId };
	return { scope: "global", scopeId: "" };
}

export class DrizzleActivityRepository implements IActivityRepository {
	constructor(private readonly db: Database) {}

	async record(input: NewActivityEvent): Promise<ActivityEvent> {
		const event: ActivityEvent = {
			id: crypto.randomUUID(),
			type: input.type,
			source: input.source,
			outcome: input.outcome ?? "success",
			reason: input.reason ?? null,
			licenseId: input.licenseId ?? null,
			customerId: input.customerId ?? null,
			keyPrefix: input.keyPrefix ?? null,
			ip: input.ip ?? null,
			deviceId: input.deviceId ?? null,
			details: input.details ?? {},
			createdAt: input.createdAt ?? new Date(),
		};
		await this.db.transaction(async (transaction) => {
			// Heartbeats are intentionally bucketed without retaining one detail row
			// per ping. All other audit/rejection/usage events remain queryable.
			if (event.type !== "license.heartbeat") {
				await transaction.insert(activityEvents).values(event);
			}

			const scopes = scopesForEvent(event);
			await transaction
				.insert(activityTotals)
				.values(
					scopes.map((scope) => ({ ...scope, type: event.type, count: 1 })),
				)
				.onConflictDoUpdate({
					target: [
						activityTotals.scope,
						activityTotals.scopeId,
						activityTotals.type,
					],
					set: { count: sql`${activityTotals.count} + 1` },
				});

			const minute = new Date(event.createdAt);
			minute.setUTCSeconds(0, 0);
			await transaction
				.insert(activityMinuteBuckets)
				.values(
					scopes.map((scope) => ({
						minute,
						...scope,
						type: event.type,
						count: 1,
					})),
				)
				.onConflictDoUpdate({
					target: [
						activityMinuteBuckets.minute,
						activityMinuteBuckets.scope,
						activityMinuteBuckets.scopeId,
						activityMinuteBuckets.type,
					],
					set: { count: sql`${activityMinuteBuckets.count} + 1` },
				});
		});
		return event;
	}

	async listDetailed(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
		const filters = [];
		if (query.licenseId)
			filters.push(eq(activityEvents.licenseId, query.licenseId));
		if (query.customerId)
			filters.push(eq(activityEvents.customerId, query.customerId));
		if (query.type) filters.push(eq(activityEvents.type, query.type));
		if (query.from) filters.push(gte(activityEvents.createdAt, query.from));
		if (query.to) filters.push(lte(activityEvents.createdAt, query.to));
		const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
		return await this.db
			.select()
			.from(activityEvents)
			.where(filters.length > 0 ? and(...filters) : undefined)
			.orderBy(desc(activityEvents.createdAt))
			.limit(limit);
	}

	async getStatistics(query: ActivityQuery = {}): Promise<ActivityStatistics> {
		const scope = queryScope(query);
		const totalFilters = [
			eq(activityTotals.scope, scope.scope),
			eq(activityTotals.scopeId, scope.scopeId),
		];
		const bucketFilters = [
			eq(activityMinuteBuckets.scope, scope.scope),
			eq(activityMinuteBuckets.scopeId, scope.scopeId),
		];
		if (query.type) {
			totalFilters.push(eq(activityTotals.type, query.type));
			bucketFilters.push(eq(activityMinuteBuckets.type, query.type));
		}
		if (query.from)
			bucketFilters.push(gte(activityMinuteBuckets.minute, query.from));
		if (query.to)
			bucketFilters.push(lte(activityMinuteBuckets.minute, query.to));
		const [totals, buckets, recent] = await Promise.all([
			this.db
				.select()
				.from(activityTotals)
				.where(and(...totalFilters))
				.orderBy(activityTotals.type),
			this.db
				.select()
				.from(activityMinuteBuckets)
				.where(and(...bucketFilters))
				.orderBy(activityMinuteBuckets.minute),
			this.listDetailed(query),
		]);
		return { totals, buckets, recent };
	}

	async pruneBefore(before: Date): Promise<number> {
		// A transaction owns one connection, so these deletes must run in
		// sequence; issuing them concurrently wedges the transaction.
		return await this.db.transaction(async (transaction) => {
			// Counting inside the CTE keeps the deleted set in Postgres. A plain
			// DELETE ... RETURNING materializes every expired row client-side, and
			// a retention window's worth of ids spikes heap on each daily prune.
			const events = await transaction.execute<{ count: number }>(
				sql`with deleted as (delete from ${activityEvents} where ${lt(activityEvents.createdAt, before)} returning 1) select count(*)::int as count from deleted`,
			);
			const buckets = await transaction.execute<{ count: number }>(
				sql`with deleted as (delete from ${activityMinuteBuckets} where ${lt(activityMinuteBuckets.minute, before)} returning 1) select count(*)::int as count from deleted`,
			);
			return (events[0]?.count ?? 0) + (buckets[0]?.count ?? 0);
		});
	}
}
