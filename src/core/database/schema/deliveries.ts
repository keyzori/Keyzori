import {
	pgTable,
	uuid,
	text,
	jsonb,
	integer,
	timestamp,
	index,
} from "drizzle-orm/pg-core";
import type { $EventEnvelope } from "../../../types/webhooks";

export const deliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid().primaryKey(),
		webhookId: uuid("webhook_id").notNull(),
		payload: jsonb().$type<$EventEnvelope>().notNull(),
		state: text({
			enum: ["pending", "claimed", "succeeded", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		attemptedAt: timestamp("attempted_at", { withTimezone: true }),
		status: integer(),
		error: text(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("deliveries_claim_idx").on(table.state, table.createdAt),
		index("deliveries_webhook_idx").on(table.webhookId, table.createdAt),
	],
);
