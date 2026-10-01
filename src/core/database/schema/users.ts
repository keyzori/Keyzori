import {
	pgTable,
	uuid,
	text,
	boolean,
	jsonb,
	timestamp,
} from "drizzle-orm/pg-core";
import type { $Metadata } from "../../../types/metadata";

export const users = pgTable("users", {
	id: uuid().primaryKey(),
	name: text().notNull(),
	enabled: boolean().notNull().default(false),
	disabledReason: text("disabled_reason"),
	metadata: jsonb().$type<$Metadata>().notNull().default({}),
	notes: text(),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
