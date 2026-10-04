import {
	pgTable,
	uuid,
	text,
	jsonb,
	timestamp,
	inet,
	index,
} from "drizzle-orm/pg-core";
import type { $Actor } from "../../../types/auth";

export const audits = pgTable(
	"audit_logs",
	{
		id: uuid().primaryKey(),
		action: text().notNull(),
		actor: jsonb().$type<$Actor>().notNull(),
		targetType: text("target_type").notNull(),
		targetId: uuid("target_id"),
		requestId: text("request_id").notNull(),
		clientIp: inet("client_ip"),
		hardwareId: text("hardware_id"),
		reason: text(),
		before: jsonb().$type<Record<string, unknown>>(),
		after: jsonb().$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("audits_time_idx").on(table.createdAt, table.id),
		index("audits_target_idx").on(table.targetId),
	],
);
