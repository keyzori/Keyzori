CREATE TYPE "license_type" AS ENUM('lifetime', 'subscription', 'metered', 'trial');--> statement-breakpoint
CREATE TABLE "device_allowlist" (
	"licenseId" uuid,
	"fingerprint" text,
	CONSTRAINT "device_allowlist_pkey" PRIMARY KEY("licenseId","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "registered_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_license_fingerprint" UNIQUE("licenseId","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "ip_allowlist" (
	"licenseId" uuid,
	"network" cidr,
	CONSTRAINT "ip_allowlist_pkey" PRIMARY KEY("licenseId","network")
);
--> statement-breakpoint
CREATE TABLE "registered_ips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid NOT NULL,
	"address" inet NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_license_address" UNIQUE("licenseId","address")
);
--> statement-breakpoint
CREATE TABLE "license_blocks" (
	"licenseId" uuid,
	"source" text,
	"reason" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_blocks_pkey" PRIMARY KEY("licenseId","source"),
	CONSTRAINT "block_source" CHECK ("source" ~ '^[a-z][a-z0-9-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid,
	"customerId" uuid,
	"action" text NOT NULL,
	"source" text DEFAULT 'core' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyzori_application" (
	"version" integer PRIMARY KEY DEFAULT 2,
	CONSTRAINT "application_version" CHECK ("version" = 2)
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"customerId" uuid NOT NULL,
	"keyHash" text NOT NULL UNIQUE,
	"type" "license_type" NOT NULL,
	"policyRevision" bigint DEFAULT 1 NOT NULL,
	"maxDevices" integer DEFAULT 1 NOT NULL,
	"maxIps" integer DEFAULT 1 NOT NULL,
	"maxSessions" integer DEFAULT 1 NOT NULL,
	"deviceAllowlistEnabled" boolean DEFAULT false NOT NULL,
	"ipAllowlistEnabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_limits" CHECK ("maxDevices" BETWEEN 1 AND 10000 AND "maxIps" BETWEEN 1 AND 10000 AND "maxSessions" BETWEEN 1 AND 10000),
	CONSTRAINT "license_revision" CHECK ("policyRevision" > 0 AND "policyRevision" <= 9007199254740991),
	CONSTRAINT "license_key_hash" CHECK ("keyHash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "license_subscriptions" (
	"licenseId" uuid PRIMARY KEY,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_trials" (
	"licenseId" uuid PRIMARY KEY,
	"durationSeconds" integer NOT NULL,
	"activatedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	CONSTRAINT "trial_duration" CHECK ("durationSeconds" BETWEEN 1 AND 31536000),
	CONSTRAINT "trial_activation" CHECK (("activatedAt" IS NULL AND "expiresAt" IS NULL) OR ("activatedAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" > "activatedAt"))
);
--> statement-breakpoint
CREATE TABLE "meters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid NOT NULL,
	"name" text NOT NULL,
	"limit" bigint NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_license_name" UNIQUE("licenseId","name"),
	CONSTRAINT "meter_id_license" UNIQUE("id","licenseId"),
	CONSTRAINT "meter_balance" CHECK ("used" >= 0 AND "limit" >= "used" AND "limit" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid NOT NULL,
	"meterId" uuid NOT NULL,
	"eventId" text NOT NULL,
	"units" bigint NOT NULL,
	"used" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_license_event" UNIQUE("licenseId","eventId"),
	CONSTRAINT "usage_positive" CHECK ("units" > 0 AND "used" >= "units" AND "remaining" >= 0 AND "used" + "remaining" <= 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity" ("createdAt");--> statement-breakpoint
CREATE INDEX "activity_license_idx" ON "activity" ("licenseId","createdAt");--> statement-breakpoint
CREATE INDEX "licenses_customer_idx" ON "licenses" ("customerId");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "usage_ledger" ("createdAt");--> statement-breakpoint
ALTER TABLE "device_allowlist" ADD CONSTRAINT "device_allowlist_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ip_allowlist" ADD CONSTRAINT "ip_allowlist_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "registered_ips" ADD CONSTRAINT "registered_ips_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_blocks" ADD CONSTRAINT "license_blocks_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_customerId_customers_id_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_customerId_customers_id_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "license_subscriptions" ADD CONSTRAINT "license_subscriptions_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_trials" ADD CONSTRAINT "license_trials_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "meters" ADD CONSTRAINT "meters_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_meterId_licenseId_meters_id_licenseId_fkey" FOREIGN KEY ("meterId","licenseId") REFERENCES "meters"("id","licenseId") ON DELETE RESTRICT;