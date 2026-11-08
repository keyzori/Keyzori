import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { actions } from "../../auth/scopes";

export const apiKeys = pgTable("api_keys", {
	id: uuid().primaryKey(),
	name: text().notNull(),
	description: text(),
	secretHash: text("secret_hash").notNull(),
	scopes: text({ enum: actions }).array().notNull().default([]),
	allGroups: boolean("all_groups").notNull().default(false),
	enabled: boolean().notNull().default(false),
	expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, precision: 3 }),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
		.notNull()
		.defaultNow(),
});
