CREATE TYPE "license_type" AS ENUM ('lifetime', 'subscription', 'metered', 'trial');
--> statement-breakpoint
CREATE TYPE "stripe_webhook_status" AS ENUM ('pending', 'processing', 'processed', 'failed');
--> statement-breakpoint
ALTER TABLE "User" RENAME TO "customers";
--> statement-breakpoint
ALTER TABLE "customers" RENAME COLUMN "customFields" TO "metadata";
--> statement-breakpoint
ALTER TABLE "customers" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "updated_at" timestamp(3) NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "customers" RENAME CONSTRAINT "User_pkey" TO "customers_pkey";
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "User_email_key";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_unique" UNIQUE ("email");
--> statement-breakpoint
ALTER TABLE "ApiKey" RENAME TO "licenses";
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "type_drafts" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "manual_revoked_at" timestamp(3);
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "manual_revocation_reason" text;
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "updated_at" timestamp(3) NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "session_revision" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "licenses"
SET "type_drafts" =
	CASE "type"
		WHEN 'PERPETUAL'::"KeyType" THEN jsonb_build_object('lifetime', '{}'::jsonb)
		WHEN 'SUBSCRIPTION'::"KeyType" THEN jsonb_build_object(
			'subscription',
			jsonb_build_object('expiresAt', CASE WHEN "expiresAt" IS NULL THEN NULL ELSE to_jsonb("expiresAt"::text) END)
		)
		WHEN 'USAGE'::"KeyType" THEN jsonb_build_object(
			'metered',
			jsonb_build_object('meterNames', jsonb_build_array('usage'))
		)
	END ||
	CASE
		WHEN "trialDurationMin" > 0 THEN jsonb_build_object(
			'trial',
			jsonb_build_object('durationMinutes', "trialDurationMin")
		)
		ELSE '{}'::jsonb
	END;
--> statement-breakpoint
UPDATE "licenses"
SET
	"manual_revoked_at" = "createdAt",
	"manual_revocation_reason" = 'Migrated manual revocation'
WHERE "revoked" = true;
--> statement-breakpoint
UPDATE "licenses"
SET "expiresAt" = "createdAt"
WHERE "type" = 'SUBSCRIPTION'::"KeyType"
	AND "trialDurationMin" = 0
	AND "expiresAt" IS NULL;
--> statement-breakpoint
ALTER TABLE "licenses" ALTER COLUMN "type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "licenses" ALTER COLUMN "type" TYPE "license_type" USING (
	CASE
		WHEN "trialDurationMin" > 0 THEN 'trial'
		WHEN "type" = 'PERPETUAL'::"KeyType" THEN 'lifetime'
		WHEN "type" = 'SUBSCRIPTION'::"KeyType" THEN 'subscription'
		WHEN "type" = 'USAGE'::"KeyType" THEN 'metered'
	END
)::"license_type";
--> statement-breakpoint
ALTER TABLE "licenses" ALTER COLUMN "type" SET DEFAULT 'lifetime'::"license_type";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "keyHash" TO "key_hash";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "keyPrefix" TO "key_prefix";
--> statement-breakpoint
ALTER TABLE "licenses" DROP COLUMN IF EXISTS "key";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "userId" TO "customer_id";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "limitIp" TO "max_ips";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "limitHwid" TO "max_devices";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "limitConcurrent" TO "max_sessions";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "trialDurationMin" TO "trial_duration_minutes";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "firstActivatedAt" TO "trial_started_at";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "customFields" TO "metadata";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "licenses" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
UPDATE "licenses"
SET
	"expires_at" = CASE WHEN "type" = 'subscription'::"license_type" THEN "expires_at" ELSE NULL END,
	"trial_duration_minutes" = CASE WHEN "type" = 'trial'::"license_type" THEN "trial_duration_minutes" ELSE 0 END,
	"trial_started_at" = CASE WHEN "type" = 'trial'::"license_type" THEN "trial_started_at" ELSE NULL END;
--> statement-breakpoint
ALTER TABLE "licenses" RENAME CONSTRAINT "ApiKey_pkey" TO "licenses_pkey";
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_keyHash_key";
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_key_hash_unique" UNIQUE ("key_hash");
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_userId_fkey";
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_customer_id_fkey"
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_limitIp_nonnegative";
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_limitHwid_nonnegative";
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_limitConcurrent_nonnegative";
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_trialDurationMin_nonnegative";
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_max_ips_nonnegative" CHECK ("max_ips" >= 0);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_max_devices_nonnegative" CHECK ("max_devices" >= 0);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_max_sessions_nonnegative" CHECK ("max_sessions" >= 0);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_session_revision_nonnegative" CHECK ("session_revision" >= 0);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_trial_duration_nonnegative" CHECK ("trial_duration_minutes" >= 0);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_subscription_expiry_required"
	CHECK ("type" <> 'subscription'::"license_type" OR "expires_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_trial_duration_required"
	CHECK ("type" <> 'trial'::"license_type" OR "trial_duration_minutes" > 0);
--> statement-breakpoint
ALTER TABLE "licenses" DROP COLUMN "revoked";
--> statement-breakpoint
ALTER TABLE "IpWhitelist" RENAME TO "license_ip_allowlist_entries";
--> statement-breakpoint
ALTER TABLE "license_ip_allowlist_entries" RENAME COLUMN "apiKeyId" TO "license_id";
--> statement-breakpoint
ALTER TABLE "license_ip_allowlist_entries" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "IpWhitelist_apiKeyId_ip_key";
--> statement-breakpoint
UPDATE "license_ip_allowlist_entries" SET "ip" = host("ip"::inet);
--> statement-breakpoint
WITH "ranked_ip_allowlist_entries" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "license_id", "ip"
			ORDER BY "created_at", "id"
		) AS "duplicate_rank"
	FROM "license_ip_allowlist_entries"
)
DELETE FROM "license_ip_allowlist_entries"
WHERE "id" IN (
	SELECT "id"
	FROM "ranked_ip_allowlist_entries"
	WHERE "duplicate_rank" > 1
);
--> statement-breakpoint
ALTER TABLE "license_ip_allowlist_entries" RENAME CONSTRAINT "IpWhitelist_pkey" TO "license_ip_allowlist_entries_pkey";
--> statement-breakpoint
ALTER TABLE "license_ip_allowlist_entries" DROP CONSTRAINT IF EXISTS "IpWhitelist_apiKeyId_fkey";
--> statement-breakpoint
ALTER TABLE "license_ip_allowlist_entries" ADD CONSTRAINT "license_ip_allowlist_license_id_fkey"
	FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "license_ip_allowlist_license_ip_unique"
	ON "license_ip_allowlist_entries" ("license_id", "ip");
--> statement-breakpoint
ALTER TABLE "HwidWhitelist" RENAME TO "license_device_allowlist_entries";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" RENAME COLUMN "apiKeyId" TO "license_id";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" RENAME COLUMN "hwid" TO "device_id";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" RENAME CONSTRAINT "HwidWhitelist_pkey" TO "license_device_allowlist_entries_pkey";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" DROP CONSTRAINT IF EXISTS "HwidWhitelist_apiKeyId_fkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "HwidWhitelist_apiKeyId_hwid_key";
--> statement-breakpoint
ALTER TABLE "license_device_allowlist_entries" ADD CONSTRAINT "license_device_allowlist_license_id_fkey"
	FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "license_device_allowlist_license_device_unique"
	ON "license_device_allowlist_entries" ("license_id", "device_id");
--> statement-breakpoint
CREATE TABLE "license_meters" (
	"id" text PRIMARY KEY,
	"license_id" text NOT NULL,
	"name" text NOT NULL,
	"balance" integer NOT NULL DEFAULT 0,
	"archived_at" timestamp(3),
	"created_at" timestamp(3) NOT NULL DEFAULT now(),
	"updated_at" timestamp(3) NOT NULL DEFAULT now(),
	CONSTRAINT "license_meters_balance_nonnegative" CHECK ("balance" >= 0),
	CONSTRAINT "license_meters_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "license_meters_license_name_unique" ON "license_meters" ("license_id", "name");
--> statement-breakpoint
UPDATE "licenses"
SET "type_drafts" = "type_drafts" || jsonb_build_object(
	'metered',
	jsonb_build_object('meterNames', jsonb_build_array('usage'))
)
WHERE "limitUsage" > 0
	AND NOT ("type_drafts" ? 'metered');
--> statement-breakpoint
INSERT INTO "license_meters" ("id", "license_id", "name", "balance", "created_at", "updated_at")
SELECT 'legacy-usage-' || "id", "id", 'usage', "limitUsage", "created_at", now()
FROM "licenses"
WHERE "type_drafts" ? 'metered';
--> statement-breakpoint
CREATE TABLE "usage_ledger_entries" (
	"id" text PRIMARY KEY,
	"license_id" text NOT NULL,
	"meter_id" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_before" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text,
	"created_at" timestamp(3) NOT NULL DEFAULT now(),
	CONSTRAINT "usage_ledger_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE,
	CONSTRAINT "usage_ledger_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "license_meters"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_license_event_unique" ON "usage_ledger_entries" ("license_id", "event_id");
--> statement-breakpoint
CREATE INDEX "usage_ledger_meter_created_idx" ON "usage_ledger_entries" ("meter_id", "created_at");
--> statement-breakpoint
INSERT INTO "usage_ledger_entries" (
	"id", "license_id", "meter_id", "event_id", "kind", "delta",
	"balance_before", "balance_after", "reason", "created_at"
)
SELECT
	'legacy-meter-ledger-' || m."license_id",
	m."license_id",
	m."id",
	'migration:create:' || m."license_id",
	'create',
	m."balance",
	0,
	m."balance",
	'Migrated legacy usage balance',
	m."created_at"
FROM "license_meters" m
WHERE m."id" LIKE 'legacy-usage-%';
--> statement-breakpoint
ALTER TABLE "licenses" DROP CONSTRAINT IF EXISTS "ApiKey_limitUsage_nonnegative";
--> statement-breakpoint
ALTER TABLE "licenses" DROP COLUMN "limitUsage";
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL DEFAULT 'success',
	"reason" text,
	"license_id" text,
	"customer_id" text,
	"key_prefix" text,
	"ip" text,
	"device_id" text,
	"details" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "activity_events_created_at_idx" ON "activity_events" ("created_at");
--> statement-breakpoint
CREATE INDEX "activity_events_license_created_idx" ON "activity_events" ("license_id", "created_at");
--> statement-breakpoint
CREATE INDEX "activity_events_customer_created_idx" ON "activity_events" ("customer_id", "created_at");
--> statement-breakpoint
CREATE TABLE "activity_totals" (
	"scope" text NOT NULL,
	"scope_id" text NOT NULL DEFAULT '',
	"type" text NOT NULL,
	"count" bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_totals_scope_type_unique" ON "activity_totals" ("scope", "scope_id", "type");
--> statement-breakpoint
CREATE TABLE "activity_minute_buckets" (
	"minute" timestamp(0) NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL DEFAULT '',
	"type" text NOT NULL,
	"count" bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_minute_buckets_unique"
	ON "activity_minute_buckets" ("minute", "scope", "scope_id", "type");
--> statement-breakpoint
CREATE INDEX "activity_minute_buckets_minute_idx" ON "activity_minute_buckets" ("minute");
--> statement-breakpoint
INSERT INTO "activity_events" (
	"id", "type", "source", "outcome", "license_id", "customer_id", "key_prefix", "ip", "device_id", "details", "created_at"
)
SELECT
	'legacy-attempt-' || a."id",
	'license.activation_attempted',
	'client',
	'success',
	a."apiKeyId",
	l."customer_id",
	l."key_prefix",
	host(a."ip"::inet),
	a."hwid",
	jsonb_build_object('attemptCount', a."attemptCount", 'firstAttemptedAt', a."firstAttemptedAt"),
	a."lastAttemptedAt"
FROM "AccessAttempt" a
JOIN "licenses" l ON l."id" = a."apiKeyId";
--> statement-breakpoint
INSERT INTO "activity_totals" ("scope", "scope_id", "type", "count")
SELECT 'global', '', 'license.activation_attempted', COALESCE(sum("attemptCount"), 0)
FROM "AccessAttempt"
HAVING count(*) > 0;
--> statement-breakpoint
INSERT INTO "activity_totals" ("scope", "scope_id", "type", "count")
SELECT 'license', "apiKeyId", 'license.activation_attempted', sum("attemptCount")
FROM "AccessAttempt"
GROUP BY "apiKeyId";
--> statement-breakpoint
INSERT INTO "activity_totals" ("scope", "scope_id", "type", "count")
SELECT 'customer', l."customer_id", 'license.activation_attempted', sum(a."attemptCount")
FROM "AccessAttempt" a
JOIN "licenses" l ON l."id" = a."apiKeyId"
GROUP BY l."customer_id";
--> statement-breakpoint
INSERT INTO "activity_minute_buckets" ("minute", "scope", "scope_id", "type", "count")
SELECT date_trunc('minute', "lastAttemptedAt"), 'global', '', 'license.activation_attempted', sum("attemptCount")
FROM "AccessAttempt"
GROUP BY date_trunc('minute', "lastAttemptedAt");
--> statement-breakpoint
INSERT INTO "activity_minute_buckets" ("minute", "scope", "scope_id", "type", "count")
SELECT date_trunc('minute', "lastAttemptedAt"), 'license', "apiKeyId", 'license.activation_attempted', sum("attemptCount")
FROM "AccessAttempt"
GROUP BY date_trunc('minute', "lastAttemptedAt"), "apiKeyId";
--> statement-breakpoint
INSERT INTO "activity_minute_buckets" ("minute", "scope", "scope_id", "type", "count")
SELECT date_trunc('minute', a."lastAttemptedAt"), 'customer', l."customer_id", 'license.activation_attempted', sum(a."attemptCount")
FROM "AccessAttempt" a
JOIN "licenses" l ON l."id" = a."apiKeyId"
GROUP BY date_trunc('minute', a."lastAttemptedAt"), l."customer_id";
--> statement-breakpoint
CREATE TABLE "registered_devices_v2" (
	"id" text PRIMARY KEY,
	"license_id" text NOT NULL,
	"ip" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" timestamp(3) NOT NULL DEFAULT now(),
	"last_seen_at" timestamp(3) NOT NULL DEFAULT now(),
	CONSTRAINT "registered_devices_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO "registered_devices_v2" ("id", "license_id", "ip", "device_id", "created_at", "last_seen_at")
SELECT DISTINCT ON (m."apiKeyId", host(d."ip"::inet), d."hwid")
	m."id", m."apiKeyId", host(d."ip"::inet), d."hwid", m."createdAt", m."createdAt"
FROM "KeyDeviceMapping" m
JOIN "RegisteredDevice" d ON d."id" = m."registeredDeviceId"
ORDER BY m."apiKeyId", host(d."ip"::inet), d."hwid", m."createdAt", m."id";
--> statement-breakpoint
INSERT INTO "activity_events" (
	"id", "type", "source", "outcome", "ip", "device_id", "details", "created_at"
)
SELECT
	'legacy-orphan-device-' || d."id",
	'license.activation_attempted',
	'system',
	'rejected',
	d."ip",
	d."hwid",
	jsonb_build_object('legacyOrphanedRegistration', true),
	d."createdAt"
FROM "RegisteredDevice" d
WHERE NOT EXISTS (
	SELECT 1 FROM "KeyDeviceMapping" m WHERE m."registeredDeviceId" = d."id"
);
--> statement-breakpoint
DROP TABLE "KeyDeviceMapping";
--> statement-breakpoint
DROP TABLE "RegisteredDevice";
--> statement-breakpoint
ALTER TABLE "registered_devices_v2" RENAME TO "registered_devices";
--> statement-breakpoint
ALTER TABLE "registered_devices" RENAME CONSTRAINT "registered_devices_v2_pkey" TO "registered_devices_pkey";
--> statement-breakpoint
CREATE UNIQUE INDEX "registered_devices_license_ip_device_unique"
	ON "registered_devices" ("license_id", "ip", "device_id");
--> statement-breakpoint
CREATE INDEX "registered_devices_license_id_idx" ON "registered_devices" ("license_id");
--> statement-breakpoint
DROP TABLE "AccessAttempt";
--> statement-breakpoint
CREATE TABLE "stripe_subscription_links" (
	"id" text PRIMARY KEY,
	"license_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"status" text NOT NULL,
	"paid_through" timestamp(3),
	"cancel_at_period_end" boolean NOT NULL DEFAULT false,
	"price_id" text,
	"billing_revoked_at" timestamp(3),
	"last_synced_at" timestamp(3),
	"last_error" text,
	"created_at" timestamp(3) NOT NULL DEFAULT now(),
	"updated_at" timestamp(3) NOT NULL DEFAULT now(),
	CONSTRAINT "stripe_subscription_links_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_subscription_links_license_unique" ON "stripe_subscription_links" ("license_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_subscription_links_subscription_unique" ON "stripe_subscription_links" ("subscription_id");
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY,
	"type" text NOT NULL,
	"object_id" text,
	"status" "stripe_webhook_status" NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"next_attempt_at" timestamp(3) NOT NULL DEFAULT now(),
	"payload" jsonb NOT NULL,
	"last_error" text,
	"received_at" timestamp(3) NOT NULL DEFAULT now(),
	"processed_at" timestamp(3)
);
--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_due_idx" ON "stripe_webhook_events" ("status", "next_attempt_at");
--> statement-breakpoint
DROP TYPE "KeyType";
