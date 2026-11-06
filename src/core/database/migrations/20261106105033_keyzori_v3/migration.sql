CREATE TABLE "api_key_groups" (
	"api_key_id" uuid,
	"group_id" uuid,
	CONSTRAINT "api_key_groups_pkey" PRIMARY KEY("api_key_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"all_groups" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp(3) with time zone,
	"last_used_at" timestamp(3) with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY,
	"action" text NOT NULL,
	"actor" jsonb NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"group_id" uuid,
	"required_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requires_all_groups" boolean DEFAULT false NOT NULL,
	"global" boolean DEFAULT true NOT NULL,
	"request_id" text NOT NULL,
	"client_ip" inet,
	"hardware_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"replay_of" uuid,
	"group_id" uuid,
	"global" boolean NOT NULL,
	"endpoint_version" integer NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"signing_key_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp(3) with time zone,
	"next_attempt_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"attempted_at" timestamp(3) with time zone,
	"status" integer,
	"error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_state_check" CHECK ("state" in ('pending','claimed','succeeded','failed','cancelled') and "attempts" between 0 and 8),
	CONSTRAINT "deliveries_lease_check" CHECK (("state" = 'claimed') = ("claim_token" is not null and "lease_until" is not null) and (("claim_token" is null) = ("lease_until" is null)))
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp(3) with time zone NOT NULL,
	"send_started_at" timestamp(3) with time zone,
	"completed_at" timestamp(3) with time zone,
	"status" integer,
	"error" text,
	CONSTRAINT "delivery_attempt_number_check" CHECK ("attempt" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY,
	"ordinal" bigserial,
	"sequence" bigint UNIQUE,
	"group_id" uuid,
	"global" boolean NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_revision" bigint NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp(3) with time zone,
	CONSTRAINT "events_publication_check" CHECK (("sequence" is null) = ("published_at" is null) and ("sequence" is null or "sequence" > 0) and "resource_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_resources" (
	"type" text,
	"id" text,
	"revision" bigint NOT NULL,
	CONSTRAINT "event_resources_pkey" PRIMARY KEY("type","id"),
	CONSTRAINT "event_resources_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_state" (
	"id" integer PRIMARY KEY,
	"epoch" uuid NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"retained_after" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "event_state_singleton" CHECK ("id" = 1 and "sequence" >= 0 and "retained_after" >= 0 and "retained_after" <= "sequence")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"notes" text,
	"key_format" jsonb,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_hardware_ids" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"hardware_id" text NOT NULL,
	"registration_order" bigserial,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardware_license_identifier_unique" UNIQUE("license_id","hardware_id")
);
--> statement-breakpoint
CREATE TABLE "license_ip_ids" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"ip" inet NOT NULL,
	"registration_order" bigserial,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ips_license_host_unique" UNIQUE("license_id","ip")
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY,
	"key_hash" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"user_id" uuid,
	"group_id" uuid,
	"expires_at" timestamp(3) with time zone,
	"device_limit" integer,
	"ip_limit" integer,
	"allowed_ips" inet[] DEFAULT '{}'::inet[] NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"notes" text,
	"key_format" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_device_limit_bounds" CHECK ("device_limit" between 0 and 1000),
	CONSTRAINT "licenses_ip_limit_bounds" CHECK ("ip_limit" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "maintenance_reset_retries" (
	"license_id" uuid PRIMARY KEY,
	"claim_token" uuid NOT NULL,
	"attempts" integer NOT NULL,
	"attempted_at" timestamp(3) with time zone NOT NULL,
	"next_attempt_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "maintenance_retry_bounds" CHECK ("attempts" between 1 and 32 and "next_attempt_at" > "attempted_at")
);
--> statement-breakpoint
CREATE TABLE "license_meters" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition_revision" integer DEFAULT 1 NOT NULL,
	"reset_generation" integer DEFAULT 0 NOT NULL,
	"value" numeric DEFAULT '0' NOT NULL,
	"limit" numeric,
	"numeric_mode" text DEFAULT 'integer' NOT NULL,
	"precision" integer DEFAULT 0 NOT NULL,
	"schedule" jsonb,
	"starts_at" timestamp(3) with time zone,
	"period_started_at" timestamp(3) with time zone,
	"next_reset_at" timestamp(3) with time zone,
	"last_scheduled_reset_at" timestamp(3) with time zone,
	"last_reset_at" timestamp(3) with time zone,
	CONSTRAINT "meters_license_name_unique" UNIQUE("license_id","name"),
	CONSTRAINT "meters_revision_bounds" CHECK ("definition_revision" > 0 and "reset_generation" >= 0),
	CONSTRAINT "meters_period_bounds" CHECK (("schedule" is null and "period_started_at" is null and "next_reset_at" is null) or ("schedule" is not null and "period_started_at" is not null and "next_reset_at" is not null and "period_started_at" < "next_reset_at")),
	CONSTRAINT "meters_numeric_bounds" CHECK ("precision" between 0 and 6 and "numeric_mode" in ('integer', 'decimal') and ("numeric_mode" <> 'integer' or "precision" = 0) and "value" >= 0 and "limit" >= 0 and "value" < power(10::numeric, 15 - "precision") and "limit" < power(10::numeric, 15 - "precision") and scale(trim_scale("value")) <= "precision" and scale(trim_scale("limit")) <= "precision")
);
--> statement-breakpoint
CREATE TABLE "idempotency_receipts" (
	"operation" text,
	"principal_id" text,
	"key" text,
	"fingerprint" text NOT NULL,
	"authority" jsonb,
	"secret_issued" jsonb,
	"result" jsonb,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "idempotency_receipts_pkey" PRIMARY KEY("operation","principal_id","key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY,
	"version" integer DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("id" = 1 and "version" = 1)
);
--> statement-breakpoint
CREATE TABLE "usage_operations" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"group_id" uuid,
	"principal_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"request_id" text NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_operation_identity" UNIQUE("license_id","principal_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"all_groups" boolean DEFAULT false NOT NULL,
	"group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"owner_api_key_id" uuid,
	"owner_credential_hash" text,
	"secret_ciphertext" text NOT NULL,
	"signing_key_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"last_dispatch_at" timestamp(3) with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_owner_check" CHECK (("owner_api_key_id" is null) = ("owner_credential_hash" is null)),
	CONSTRAINT "webhooks_groups_check" CHECK (cardinality("group_ids") <= 100 and (not "all_groups" or cardinality("group_ids") = 0)),
	CONSTRAINT "webhooks_version_check" CHECK ("version" > 0 and "last_sequence" >= 0)
);
--> statement-breakpoint
CREATE INDEX "api_key_groups_group_idx" ON "api_key_groups" ("group_id");--> statement-breakpoint
CREATE INDEX "audits_time_idx" ON "audit_logs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "audits_target_idx" ON "audit_logs" ("target_id");--> statement-breakpoint
CREATE INDEX "audits_group_time_idx" ON "audit_logs" ("group_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_idx" ON "webhook_deliveries" ("webhook_id","event_id") WHERE "replay_of" is null;--> statement-breakpoint
CREATE INDEX "deliveries_claim_idx" ON "webhook_deliveries" ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "deliveries_expired_lease_idx" ON "webhook_deliveries" ("lease_until") WHERE "state" = 'claimed';--> statement-breakpoint
CREATE INDEX "deliveries_retention_idx" ON "webhook_deliveries" ("created_at","id") WHERE "state" in ('succeeded','failed','cancelled');--> statement-breakpoint
CREATE INDEX "deliveries_webhook_idx" ON "webhook_deliveries" ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_attempts_delivery_idx" ON "webhook_delivery_attempts" ("delivery_id","started_at");--> statement-breakpoint
CREATE INDEX "events_unpublished_idx" ON "activity_events" ("ordinal") WHERE "sequence" is null;--> statement-breakpoint
CREATE INDEX "events_group_sequence_idx" ON "activity_events" ("group_id","sequence");--> statement-breakpoint
CREATE INDEX "events_retention_idx" ON "activity_events" ("sequence","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_resource_revision_idx" ON "activity_events" ("resource_type","resource_id","resource_revision");--> statement-breakpoint
CREATE INDEX "groups_created_idx" ON "groups" ("created_at","id");--> statement-breakpoint
CREATE INDEX "groups_updated_idx" ON "groups" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "hardware_license_order_idx" ON "license_hardware_ids" ("license_id","registration_order");--> statement-breakpoint
CREATE INDEX "ips_license_order_idx" ON "license_ip_ids" ("license_id","registration_order");--> statement-breakpoint
CREATE INDEX "licenses_user_idx" ON "licenses" ("user_id");--> statement-breakpoint
CREATE INDEX "licenses_group_idx" ON "licenses" ("group_id");--> statement-breakpoint
CREATE INDEX "licenses_expiry_idx" ON "licenses" ("expires_at");--> statement-breakpoint
CREATE INDEX "licenses_created_idx" ON "licenses" ("created_at","id");--> statement-breakpoint
CREATE INDEX "licenses_updated_idx" ON "licenses" ("updated_at","id");--> statement-breakpoint
CREATE INDEX "meters_due_idx" ON "license_meters" ("next_reset_at","license_id") WHERE "next_reset_at" is not null;--> statement-breakpoint
CREATE INDEX "receipts_expiry_idx" ON "idempotency_receipts" ("expires_at");--> statement-breakpoint
CREATE INDEX "usage_license_time_idx" ON "usage_operations" ("license_id","created_at","id");--> statement-breakpoint
CREATE INDEX "usage_group_time_idx" ON "usage_operations" ("group_id","created_at","id");--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" ("created_at","id");--> statement-breakpoint
CREATE INDEX "users_updated_idx" ON "users" ("updated_at","id");--> statement-breakpoint
ALTER TABLE "api_key_groups" ADD CONSTRAINT "api_key_groups_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_cv3F3BkxuyfX_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_hardware_ids" ADD CONSTRAINT "license_hardware_ids_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_ip_ids" ADD CONSTRAINT "license_ip_ids_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "maintenance_reset_retries" ADD CONSTRAINT "maintenance_reset_retries_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_meters" ADD CONSTRAINT "license_meters_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;