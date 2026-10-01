import {
	pgTable,
	uuid,
	inet,
	bigserial,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { licenses } from "./licenses";

export const ips = pgTable(
	"license_ip_ids",
	{
		id: uuid().primaryKey(),
		licenseId: uuid("license_id")
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		ip: inet().notNull(),
		registrationOrder: bigserial("registration_order", {
			mode: "number",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [unique("ips_license_host_unique").on(table.licenseId, table.ip)],
);
