import {
	pgTable,
	uuid,
	text,
	jsonb,
	timestamp,
	inet,
	index,
	boolean,
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
		groupId: uuid("group_id"),
		requiredGroupIds: uuid("required_group_ids").array().notNull().default([]),
		requiresAllGroups: boolean("requires_all_groups").notNull().default(false),
		global: boolean().notNull().default(true),
		requestId: text("request_id").notNull(),
		clientIp: inet("client_ip"),
		hardwareId: text("hardware_id"),
		reason: text(),
		before: jsonb().$type<Record<string, unknown>>(),
		after: jsonb().$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("audits_time_idx").on(table.createdAt, table.id),
		index("audits_target_idx").on(table.targetId),
		index("audits_group_time_idx").on(table.groupId, table.createdAt, table.id),
	],
);
