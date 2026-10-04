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
import { items } from "./items";
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
		itemId: uuid("item_id").references(() => items.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		deviceLimit: integer("device_limit"),
		ipLimit: integer("ip_limit"),
		allowedIps: inet("allowed_ips").array().notNull().default([]),
		metadata: jsonb().$type<$Metadata>().notNull().default({}),
		notes: text(),
		keyFormat: jsonb("key_format").$type<$KeyFormat>().notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check("licenses_device_limit_nonnegative", sql`${table.deviceLimit} >= 0`),
		check("licenses_ip_limit_nonnegative", sql`${table.ipLimit} >= 0`),
		index("licenses_user_idx").on(table.userId),
		index("licenses_item_idx").on(table.itemId),
		index("licenses_expiry_idx").on(table.expiresAt),
	],
);
