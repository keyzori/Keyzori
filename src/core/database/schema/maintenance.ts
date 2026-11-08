import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, integer, uuid } from "drizzle-orm/pg-core";
import { licenses } from "./licenses";

/** A committed retry reservation survives a failed reset, process exit and other workers. */
export const maintenanceRetries = pgTable(
	"maintenance_reset_retries",
	{
		licenseId: uuid("license_id")
			.primaryKey()
			.references(() => licenses.id, { onDelete: "cascade" }),
		claimToken: uuid("claim_token").notNull(),
		attempts: integer().notNull(),
		attemptedAt: timestamp("attempted_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
	},
	(table) => [
		check(
			"maintenance_retry_bounds",
			sql`${table.attempts} between 1 and 32 and ${table.nextAttemptAt} > ${table.attemptedAt}`,
		),
	],
);
