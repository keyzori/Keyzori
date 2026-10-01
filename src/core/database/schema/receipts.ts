import {
	pgTable,
	text,
	jsonb,
	timestamp,
	primaryKey,
	index,
} from "drizzle-orm/pg-core";

export const receipts = pgTable(
	"idempotency_receipts",
	{
		operation: text().notNull(),
		principalId: text("principal_id").notNull(),
		key: text().notNull(),
		fingerprint: text().notNull(),
		secretIssued: jsonb("secret_issued").$type<string[]>(),
		result: jsonb().$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.operation, table.principalId, table.key] }),
		index("receipts_expiry_idx").on(table.expiresAt),
	],
);
