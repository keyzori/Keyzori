import { sql } from "drizzle-orm";
import type { Database } from "../database/Database";
import type { Metrics } from "./Metrics";

/** One snapshot, bounded per state by the (state, next_attempt_at) claim index. */
export class WebhookQueueObserver {
	constructor(
		private readonly database: Pick<Database, "transaction">,
		private readonly metrics: Metrics,
		private readonly limit = 10000,
	) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
			throw new Error("Invalid webhook observation budget");
	}
	async observe(deadlineAt: number) {
		const limit = this.limit;
		const sample = await this.database.transaction(
			async (tx) => {
				const [row] = await tx.execute<{
					pending: number;
					claimed: number;
					oldestSeconds: number;
				}>(sql`
				with sample as (
					(select state, created_at from webhook_deliveries where state = 'pending' order by next_attempt_at limit ${limit})
					union all
					(select state, created_at from webhook_deliveries where state = 'claimed' order by next_attempt_at limit ${limit})
				)
				select (count(*) filter (where state = 'pending'))::integer as pending,
					(count(*) filter (where state = 'claimed'))::integer as claimed,
					greatest(0, extract(epoch from statement_timestamp() - min(created_at)))::float8 as "oldestSeconds"
				from sample`);
				if (!row) throw new Error("Missing webhook queue observation");
				return row;
			},
			"none",
			deadlineAt,
		);
		// Nothing changes on failure, including the observation timestamp.
		this.metrics.webhookQueue(sample, limit);
	}
}
