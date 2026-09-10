import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { licenses } from "../../src/licenses/tables.ts";

export const stripeLinks = pgTable("stripe_links", {
	id: uuid().defaultRandom().primaryKey(),
	licenseId: uuid()
		.notNull()
		.unique()
		.references(() => licenses.id, { onDelete: "restrict" }),
	subscriptionId: text().notNull().unique(),
	customerId: text().notNull(),
	status: text().notNull(),
	syncedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const stripeEvents = pgTable(
	"stripe_events",
	{
		id: uuid().defaultRandom().primaryKey(),
		eventId: text().notNull().unique(),
		eventType: text().notNull(),
		subscriptionId: text(),
		state: text().notNull().default("pending"),
		attempts: integer().notNull().default(0),
		claim: uuid(),
		leaseUntil: timestamp({ withTimezone: true }),
		nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		completedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("stripe_event_work_idx").on(t.state, t.nextAttemptAt),
		check(
			"stripe_event_state",
			sql`${t.state} IN ('pending', 'processing', 'completed')`,
		),
		check("stripe_event_attempts", sql`${t.attempts} >= 0`),
	],
);
