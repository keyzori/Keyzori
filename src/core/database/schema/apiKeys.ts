import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const apiKeys = pgTable("api_keys", {
	id: uuid().primaryKey(),
	name: text().notNull(),
	secretHash: text("secret_hash").notNull(),
	scopes: text().array().notNull(),
	enabled: boolean().notNull().default(false),
	expiresAt: timestamp("expires_at", { withTimezone: true }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
