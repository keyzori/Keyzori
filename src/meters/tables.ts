import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { licenses } from "../licenses/tables.ts";

export const meters = pgTable(
	"meters",
	{
		id: uuid().defaultRandom().primaryKey(),
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		name: text().notNull(),
		limit: bigint({ mode: "number" }).notNull(),
		used: bigint({ mode: "number" }).notNull().default(0),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("meter_license_name").on(t.licenseId, t.name),
		unique("meter_id_license").on(t.id, t.licenseId),
		check(
			"meter_balance",
			sql`${t.used} >= 0 AND ${t.limit} >= ${t.used} AND ${t.limit} <= 9007199254740991`,
		),
	],
);

export const usageLedger = pgTable(
	"usage_ledger",
	{
		id: uuid().defaultRandom().primaryKey(),
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		meterId: uuid().notNull(),
		eventId: text().notNull(),
		units: bigint({ mode: "number" }).notNull(),
		used: bigint({ mode: "number" }).notNull(),
		remaining: bigint({ mode: "number" }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("usage_license_event").on(t.licenseId, t.eventId),
		foreignKey({
			columns: [t.meterId, t.licenseId],
			foreignColumns: [meters.id, meters.licenseId],
		}).onDelete("restrict"),
		index("usage_created_idx").on(t.createdAt),
		check(
			"usage_positive",
			sql`${t.units} > 0 AND ${t.used} >= ${t.units} AND ${t.remaining} >= 0 AND ${t.used} + ${t.remaining} <= 9007199254740991`,
		),
	],
);
