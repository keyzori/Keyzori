import { sql } from "drizzle-orm";
import {
	check,
	pgTable,
	uuid,
	text,
	boolean,
	jsonb,
	timestamp,
	integer,
	inet,
	index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { groups } from "./groups";
import type { $Metadata } from "../../../types/metadata";
import type { $KeyFormat } from "../../../types/security";

export const licenses = pgTable(
	"licenses",
	{
		id: uuid().primaryKey(),
		keyHash: text("key_hash").notNull().unique(),
		enabled: boolean().notNull().default(false),
		disabledReason: text("disabled_reason"),
		userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
		groupId: uuid("group_id").references(() => groups.id, {
			onDelete: "restrict",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }),
		deviceLimit: integer("device_limit"),
		ipLimit: integer("ip_limit"),
		allowedIps: inet("allowed_ips").array().notNull().default([]),
		metadata: jsonb().$type<$Metadata>().notNull().default({}),
		notes: text(),
		keyFormat: jsonb("key_format").$type<$KeyFormat>().notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"licenses_device_limit_bounds",
			sql`${table.deviceLimit} between 0 and 1000`,
		),
		check("licenses_ip_limit_bounds", sql`${table.ipLimit} between 0 and 1000`),
		index("licenses_user_idx").on(table.userId),
		index("licenses_group_created_idx").on(
			table.groupId,
			table.createdAt,
			table.id,
		),
		index("licenses_expiry_idx").on(table.expiresAt),
		index("licenses_created_idx").on(table.createdAt, table.id),
		index("licenses_updated_idx").on(table.updatedAt, table.id),
	],
);
