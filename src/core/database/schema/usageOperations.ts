import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { $UsageEntry } from "../../../types/meters";

/** Accepted consumption remains identifiable after key rotation or entity deletion. */
export const usageOperations = pgTable(
	"usage_operations",
	{
		id: uuid().primaryKey(),
		licenseId: uuid("license_id").notNull(),
		groupId: uuid("group_id"),
		principalId: text("principal_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		fingerprint: text().notNull(),
		requestId: text("request_id").notNull(),
		entries: jsonb().$type<$UsageEntry[]>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("usage_operation_identity").on(
			table.licenseId,
			table.principalId,
			table.idempotencyKey,
		),
		index("usage_license_time_idx").on(
			table.licenseId,
			table.createdAt,
			table.id,
		),
		index("usage_group_time_idx").on(table.groupId, table.createdAt, table.id),
	],
);
