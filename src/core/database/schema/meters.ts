import { sql } from "drizzle-orm";
import {
	check,
	pgTable,
	uuid,
	text,
	numeric,
	integer,
	boolean,
	jsonb,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { licenses } from "./licenses";
import type { $MeterSchedule } from "../../../types/meters";

export const meters = pgTable(
	"license_meters",
	{
		id: uuid().primaryKey(),
		licenseId: uuid("license_id")
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		name: text().notNull(),
		value: numeric().notNull().default("0"),
		limit: numeric().notNull(),
		allowOverage: boolean("allow_overage").notNull().default(false),
		numericMode: text("numeric_mode", { enum: ["integer", "decimal"] })
			.notNull()
			.default("integer"),
		precision: integer().notNull().default(0),
		schedule: jsonb().$type<$MeterSchedule>(),
		nextResetAt: timestamp("next_reset_at", { withTimezone: true }),
		lastScheduledResetAt: timestamp("last_scheduled_reset_at", {
			withTimezone: true,
		}),
		lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"meters_numeric_bounds",
			sql`${table.precision} between 0 and 6 and ${table.numericMode} in ('integer', 'decimal') and (${table.numericMode} <> 'integer' or ${table.precision} = 0) and ${table.value} >= 0 and ${table.limit} >= 0 and ${table.value} < power(10::numeric, 15 - ${table.precision}) and ${table.limit} < power(10::numeric, 15 - ${table.precision}) and scale(trim_scale(${table.value})) <= ${table.precision} and scale(trim_scale(${table.limit})) <= ${table.precision}`,
		),
		unique("meters_license_name_unique").on(table.licenseId, table.name),
	],
);
