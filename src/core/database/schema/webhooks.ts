import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const webhooks = pgTable("webhooks", {
	id: uuid().primaryKey(),
	url: text().notNull(),
	events: text().array().notNull(),
	enabled: boolean().notNull().default(false),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
