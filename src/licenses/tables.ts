import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { customers } from "../customers/tables.ts";

export const licenseType = pgEnum("license_type", [
	"lifetime",
	"subscription",
	"metered",
	"trial",
]);
export const licenses = pgTable(
	"licenses",
	{
		id: uuid().defaultRandom().primaryKey(),
		customerId: uuid()
			.notNull()
			.references(() => customers.id, { onDelete: "restrict" }),
		keyHash: text().notNull().unique(),
		type: licenseType().notNull(),
		policyRevision: bigint({ mode: "number" }).notNull().default(1),
		maxDevices: integer().notNull().default(1),
		maxIps: integer().notNull().default(1),
		maxSessions: integer().notNull().default(1),
		deviceAllowlistEnabled: boolean().notNull().default(false),
		ipAllowlistEnabled: boolean().notNull().default(false),
		metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("licenses_customer_idx").on(t.customerId),
		check(
			"license_limits",
			sql`${t.maxDevices} BETWEEN 1 AND 10000 AND ${t.maxIps} BETWEEN 1 AND 10000 AND ${t.maxSessions} BETWEEN 1 AND 10000`,
		),
		check(
			"license_revision",
			sql`${t.policyRevision} > 0 AND ${t.policyRevision} <= 9007199254740991`,
		),
		check("license_key_hash", sql`${t.keyHash} ~ '^[a-f0-9]{64}$'`),
	],
);

export const subscriptions = pgTable("license_subscriptions", {
	licenseId: uuid()
		.primaryKey()
		.references(() => licenses.id, { onDelete: "cascade" }),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const trials = pgTable(
	"license_trials",
	{
		licenseId: uuid()
			.primaryKey()
			.references(() => licenses.id, { onDelete: "cascade" }),
		durationSeconds: integer().notNull(),
		activatedAt: timestamp({ withTimezone: true }),
		expiresAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		check("trial_duration", sql`${t.durationSeconds} BETWEEN 1 AND 31536000`),
		check(
			"trial_activation",
			sql`(${t.activatedAt} IS NULL AND ${t.expiresAt} IS NULL) OR (${t.activatedAt} IS NOT NULL AND ${t.expiresAt} IS NOT NULL AND ${t.expiresAt} > ${t.activatedAt})`,
		),
	],
);
