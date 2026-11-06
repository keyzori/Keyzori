import { sql } from "drizzle-orm";
import {
	check,
	pgTable,
	uuid,
	text,
	numeric,
	integer,
	index,
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
		definitionRevision: integer("definition_revision").notNull().default(1),
		resetGeneration: integer("reset_generation").notNull().default(0),
		value: numeric().notNull().default("0"),
		limit: numeric(),
		numericMode: text("numeric_mode", { enum: ["integer", "decimal"] })
			.notNull()
			.default("integer"),
		precision: integer().notNull().default(0),
		schedule: jsonb().$type<$MeterSchedule>(),
		startsAt: timestamp("starts_at", { withTimezone: true, precision: 3 }),
		periodStartedAt: timestamp("period_started_at", {
			withTimezone: true,
			precision: 3,
		}),
		nextResetAt: timestamp("next_reset_at", {
			withTimezone: true,
			precision: 3,
		}),
		lastScheduledResetAt: timestamp("last_scheduled_reset_at", {
			withTimezone: true,
			precision: 3,
		}),
		lastResetAt: timestamp("last_reset_at", {
			withTimezone: true,
			precision: 3,
		}),
	},
	(table) => [
		check(
			"meters_revision_bounds",
			sql`${table.definitionRevision} > 0 and ${table.resetGeneration} >= 0`,
		),
		check(
			"meters_period_bounds",
			sql`(${table.schedule} is null and ${table.periodStartedAt} is null and ${table.nextResetAt} is null) or (${table.schedule} is not null and ${table.periodStartedAt} is not null and ${table.nextResetAt} is not null and ${table.periodStartedAt} < ${table.nextResetAt})`,
		),
		check(
			"meters_numeric_bounds",
			sql`${table.precision} between 0 and 6 and ${table.numericMode} in ('integer', 'decimal') and (${table.numericMode} <> 'integer' or ${table.precision} = 0) and ${table.value} >= 0 and ${table.limit} >= 0 and ${table.value} < power(10::numeric, 15 - ${table.precision}) and ${table.limit} < power(10::numeric, 15 - ${table.precision}) and scale(trim_scale(${table.value})) <= ${table.precision} and scale(trim_scale(${table.limit})) <= ${table.precision}`,
		),
		unique("meters_license_name_unique").on(table.licenseId, table.name),
		index("meters_due_idx")
			.on(table.nextResetAt, table.licenseId)
			.where(sql`${table.nextResetAt} is not null`),
	],
);
