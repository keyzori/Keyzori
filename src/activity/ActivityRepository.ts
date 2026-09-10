import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Executor } from "../database/Database.ts";
import type { Page } from "../shared/schemas.ts";
import { activity } from "./tables.ts";
import type { activityQuery } from "./schemas.ts";

export class ActivityRepository {
	constructor(private readonly db: Executor) {}
	write(
		tx: Executor,
		action: string,
		licenseId?: string,
		customerId?: string,
		source = "core",
	) {
		return tx
			.insert(activity)
			.values({ action, licenseId, customerId, source });
	}
	list(filter: typeof activityQuery.infer, page: Page) {
		return this.db
			.select()
			.from(activity)
			.where(this.filter(filter))
			.orderBy(desc(activity.createdAt), desc(activity.id))
			.limit(page.limit + 1)
			.offset(page.offset);
	}
	stats(filter: typeof activityQuery.infer) {
		return this.db
			.select({ action: activity.action, count: count() })
			.from(activity)
			.where(this.filter(filter))
			.groupBy(activity.action)
			.orderBy(activity.action);
	}
	async prune(before: Date) {
		const rows = await this.db.execute<{ deleted: number }>(
			sql`WITH removed AS (DELETE FROM ${activity} WHERE ${activity.createdAt} < ${before.toISOString()}::timestamptz RETURNING 1) SELECT count(*)::integer AS deleted FROM removed`,
		);
		return rows[0]?.deleted ?? 0;
	}
	private filter(f: typeof activityQuery.infer) {
		return and(
			f.licenseId ? eq(activity.licenseId, f.licenseId) : undefined,
			f.customerId ? eq(activity.customerId, f.customerId) : undefined,
			f.action ? eq(activity.action, f.action) : undefined,
			f.source ? eq(activity.source, f.source) : undefined,
			f.from ? gte(activity.createdAt, new Date(f.from)) : undefined,
			f.to ? lte(activity.createdAt, new Date(f.to)) : undefined,
		);
	}
}
