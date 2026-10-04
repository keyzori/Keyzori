import { pgTable, integer, jsonb } from "drizzle-orm/pg-core";
import type { $Settings } from "../../../types/settings";

export const settings = pgTable("settings", {
	id: integer().primaryKey(),
	value: jsonb().$type<$Settings>().notNull(),
});
