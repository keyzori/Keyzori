import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
	ActivityEventType,
	ActivityOutcome,
	ActivityScope,
	ActivitySource,
	JsonObject,
	LicenseTypeDrafts,
	MeterLedgerKind,
} from "../domain/entities";

const createdAt = () =>
	timestamp("created_at", { mode: "date", precision: 3 })
		.notNull()
		.defaultNow();
const updatedAt = () =>
	timestamp("updated_at", { mode: "date", precision: 3 })
		.notNull()
		.defaultNow();

export const licenseType = pgEnum("license_type", [
	"lifetime",
	"subscription",
	"metered",
	"trial",
]);

export const stripeWebhookStatus = pgEnum("stripe_webhook_status", [
	"pending",
	"processing",
	"processed",
	"failed",
]);

export const customers = pgTable("customers", {
	id: text().primaryKey(),
	email: text().notNull().unique("customers_email_unique"),
	name: text().notNull(),
	metadata: jsonb().$type<JsonObject>().notNull().default({}),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const licenses = pgTable(
	"licenses",
	{
		id: text().primaryKey(),
		keyHash: text("key_hash").notNull().unique("licenses_key_hash_unique"),
		keyPrefix: text("key_prefix").notNull(),
		customerId: text("customer_id").notNull(),
		type: licenseType().notNull().default("lifetime"),
		maxIps: integer("max_ips").notNull().default(0),
		maxDevices: integer("max_devices").notNull().default(0),
		maxSessions: integer("max_sessions").notNull().default(0),
		sessionRevision: integer("session_revision").notNull().default(0),
		trialDurationMinutes: integer("trial_duration_minutes")
			.notNull()
			.default(0),
		trialStartedAt: timestamp("trial_started_at", {
			mode: "date",
			precision: 3,
		}),
		metadata: jsonb().$type<JsonObject>().notNull().default({}),
		expiresAt: timestamp("expires_at", { mode: "date", precision: 3 }),
		typeDrafts: jsonb("type_drafts")
			.$type<LicenseTypeDrafts>()
			.notNull()
			.default({}),
		manualRevokedAt: timestamp("manual_revoked_at", {
			mode: "date",
			precision: 3,
		}),
		manualRevocationReason: text("manual_revocation_reason"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("licenses_max_ips_nonnegative", sql`${table.maxIps} >= 0`),
		check("licenses_max_devices_nonnegative", sql`${table.maxDevices} >= 0`),
		check("licenses_max_sessions_nonnegative", sql`${table.maxSessions} >= 0`),
		check(
			"licenses_session_revision_nonnegative",
			sql`${table.sessionRevision} >= 0`,
		),
		check(
			"licenses_trial_duration_nonnegative",
			sql`${table.trialDurationMinutes} >= 0`,
		),
		check(
			"licenses_subscription_expiry_required",
			sql`${table.type} <> 'subscription'::license_type OR ${table.expiresAt} IS NOT NULL`,
		),
		check(
			"licenses_trial_duration_required",
			sql`${table.type} <> 'trial'::license_type OR ${table.trialDurationMinutes} > 0`,
		),
		foreignKey({
			columns: [table.customerId],
			foreignColumns: [customers.id],
			name: "licenses_customer_id_fkey",
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const licenseIpAllowlistEntries = pgTable(
	"license_ip_allowlist_entries",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		ip: text().notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("license_ip_allowlist_license_ip_unique").on(
			table.licenseId,
			table.ip,
		),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "license_ip_allowlist_license_id_fkey",
		}).onDelete("cascade"),
	],
);

export const licenseDeviceAllowlistEntries = pgTable(
	"license_device_allowlist_entries",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		deviceId: text("device_id").notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("license_device_allowlist_license_device_unique").on(
			table.licenseId,
			table.deviceId,
		),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "license_device_allowlist_license_id_fkey",
		}).onDelete("cascade"),
	],
);

export const registeredDevices = pgTable(
	"registered_devices",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		ip: text().notNull(),
		deviceId: text("device_id").notNull(),
		createdAt: createdAt(),
		lastSeenAt: timestamp("last_seen_at", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("registered_devices_license_ip_device_unique").on(
			table.licenseId,
			table.ip,
			table.deviceId,
		),
		index("registered_devices_license_id_idx").on(table.licenseId),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "registered_devices_license_id_fkey",
		}).onDelete("cascade"),
	],
);

export const licenseMeters = pgTable(
	"license_meters",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		name: text().notNull(),
		balance: integer().notNull().default(0),
		archivedAt: timestamp("archived_at", { mode: "date", precision: 3 }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("license_meters_balance_nonnegative", sql`${table.balance} >= 0`),
		uniqueIndex("license_meters_license_name_unique").on(
			table.licenseId,
			table.name,
		),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "license_meters_license_id_fkey",
		}).onDelete("cascade"),
	],
);

export const usageLedgerEntries = pgTable(
	"usage_ledger_entries",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		meterId: text("meter_id").notNull(),
		eventId: text("event_id").notNull(),
		kind: text().$type<MeterLedgerKind>().notNull(),
		delta: integer().notNull(),
		balanceBefore: integer("balance_before").notNull(),
		balanceAfter: integer("balance_after").notNull(),
		reason: text(),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("usage_ledger_license_event_unique").on(
			table.licenseId,
			table.eventId,
		),
		index("usage_ledger_meter_created_idx").on(table.meterId, table.createdAt),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "usage_ledger_license_id_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.meterId],
			foreignColumns: [licenseMeters.id],
			name: "usage_ledger_meter_id_fkey",
		}).onDelete("cascade"),
	],
);

export const activityEvents = pgTable(
	"activity_events",
	{
		id: text().primaryKey(),
		type: text().$type<ActivityEventType>().notNull(),
		source: text().$type<ActivitySource>().notNull(),
		outcome: text().$type<ActivityOutcome>().notNull().default("success"),
		reason: text(),
		licenseId: text("license_id"),
		customerId: text("customer_id"),
		keyPrefix: text("key_prefix"),
		ip: text(),
		deviceId: text("device_id"),
		details: jsonb().$type<JsonObject>().notNull().default({}),
		createdAt: createdAt(),
	},
	(table) => [
		index("activity_events_created_at_idx").on(table.createdAt),
		index("activity_events_license_created_idx").on(
			table.licenseId,
			table.createdAt,
		),
		index("activity_events_customer_created_idx").on(
			table.customerId,
			table.createdAt,
		),
	],
);

export const activityTotals = pgTable(
	"activity_totals",
	{
		scope: text().$type<ActivityScope>().notNull(),
		scopeId: text("scope_id").notNull().default(""),
		type: text().$type<ActivityEventType>().notNull(),
		count: bigint({ mode: "number" }).notNull().default(0),
	},
	(table) => [
		uniqueIndex("activity_totals_scope_type_unique").on(
			table.scope,
			table.scopeId,
			table.type,
		),
	],
);

export const activityMinuteBuckets = pgTable(
	"activity_minute_buckets",
	{
		minute: timestamp({ mode: "date", precision: 0 }).notNull(),
		scope: text().$type<ActivityScope>().notNull(),
		scopeId: text("scope_id").notNull().default(""),
		type: text().$type<ActivityEventType>().notNull(),
		count: bigint({ mode: "number" }).notNull().default(0),
	},
	(table) => [
		uniqueIndex("activity_minute_buckets_unique").on(
			table.minute,
			table.scope,
			table.scopeId,
			table.type,
		),
		index("activity_minute_buckets_minute_idx").on(table.minute),
	],
);

export const stripeSubscriptionLinks = pgTable(
	"stripe_subscription_links",
	{
		id: text().primaryKey(),
		licenseId: text("license_id").notNull(),
		subscriptionId: text("subscription_id").notNull(),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		status: text().notNull(),
		paidThrough: timestamp("paid_through", { mode: "date", precision: 3 }),
		cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
		priceId: text("price_id"),
		billingRevokedAt: timestamp("billing_revoked_at", {
			mode: "date",
			precision: 3,
		}),
		lastSyncedAt: timestamp("last_synced_at", {
			mode: "date",
			precision: 3,
		}),
		lastError: text("last_error"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		uniqueIndex("stripe_subscription_links_license_unique").on(table.licenseId),
		uniqueIndex("stripe_subscription_links_subscription_unique").on(
			table.subscriptionId,
		),
		foreignKey({
			columns: [table.licenseId],
			foreignColumns: [licenses.id],
			name: "stripe_subscription_links_license_id_fkey",
		}).onDelete("cascade"),
	],
);

export const stripeWebhookEvents = pgTable(
	"stripe_webhook_events",
	{
		eventId: text("event_id").primaryKey(),
		type: text().notNull(),
		objectId: text("object_id"),
		status: stripeWebhookStatus().notNull().default("pending"),
		attempts: integer().notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", {
			mode: "date",
			precision: 3,
		})
			.notNull()
			.defaultNow(),
		payload: jsonb().$type<JsonObject>().notNull(),
		lastError: text("last_error"),
		receivedAt: timestamp("received_at", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		processedAt: timestamp("processed_at", { mode: "date", precision: 3 }),
	},
	(table) => [
		index("stripe_webhook_events_due_idx").on(
			table.status,
			table.nextAttemptAt,
		),
	],
);
