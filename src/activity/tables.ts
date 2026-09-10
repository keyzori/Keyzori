import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { licenses } from "../licenses/tables.ts";
import { customers } from "../customers/tables.ts";

// Audit records contain only fixed event names and identifiers. No request payloads.
export const activity = pgTable(
	"activity",
	{
		id: uuid().defaultRandom().primaryKey(),
		licenseId: uuid().references(() => licenses.id, { onDelete: "set null" }),
		customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
		action: text().notNull(),
		source: text().notNull().default("core"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("activity_created_idx").on(t.createdAt),
		index("activity_license_idx").on(t.licenseId, t.createdAt),
	],
);
