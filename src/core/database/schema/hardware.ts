import {
	pgTable,
	uuid,
	text,
	bigserial,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { licenses } from "./licenses";

export const hardware = pgTable(
	"license_hardware_ids",
	{
		id: uuid().primaryKey(),
		licenseId: uuid("license_id")
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		hardwareId: text("hardware_id").notNull(),
		registrationOrder: bigserial("registration_order", {
			mode: "number",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		unique("hardware_license_identifier_unique").on(
			table.licenseId,
			table.hardwareId,
		),
	],
);
