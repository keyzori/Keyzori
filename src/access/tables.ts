import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	cidr,
	inet,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { licenses } from "../licenses/tables.ts";

export const licenseBlocks = pgTable(
	"license_blocks",
	{
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		source: text().notNull(),
		reason: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.licenseId, t.source] }),
		check("block_source", sql`${t.source} ~ '^[a-z][a-z0-9-]{0,63}$'`),
	],
);

export const devices = pgTable(
	"registered_devices",
	{
		id: uuid().defaultRandom().primaryKey(),
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		fingerprint: text().notNull(),
		blocked: boolean().notNull().default(false),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique("device_license_fingerprint").on(t.licenseId, t.fingerprint)],
);

export const ips = pgTable(
	"registered_ips",
	{
		id: uuid().defaultRandom().primaryKey(),
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		address: inet().notNull(),
		blocked: boolean().notNull().default(false),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [unique("ip_license_address").on(t.licenseId, t.address)],
);

export const deviceAllowlist = pgTable(
	"device_allowlist",
	{
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		fingerprint: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.licenseId, t.fingerprint] })],
);

export const ipAllowlist = pgTable(
	"ip_allowlist",
	{
		licenseId: uuid()
			.notNull()
			.references(() => licenses.id, { onDelete: "cascade" }),
		network: cidr().notNull(),
	},
	(t) => [primaryKey({ columns: [t.licenseId, t.network] })],
);
