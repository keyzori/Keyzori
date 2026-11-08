import { pgTable, integer, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { $Settings } from "../../../types/settings";

export const settings = pgTable(
	"settings",
	{
		id: integer().primaryKey(),
		version: integer().notNull().default(1),
		value: jsonb().$type<$Settings>().notNull(),
	},
	(table) => [
		check("settings_singleton", sql`${table.id} = 1 and ${table.version} = 1`),
	],
);
