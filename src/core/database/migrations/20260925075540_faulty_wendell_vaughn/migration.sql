CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY,
	"action" text NOT NULL,
	"actor" jsonb NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"request_id" text NOT NULL,
	"client_ip" inet,
	"hardware_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY,
	"webhook_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempted_at" timestamp with time zone,
	"status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_hardware_ids" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"hardware_id" text NOT NULL,
	"registration_order" bigserial,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardware_license_identifier_unique" UNIQUE("license_id","hardware_id")
);
--> statement-breakpoint
CREATE TABLE "license_ip_ids" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"ip" inet NOT NULL,
	"registration_order" bigserial,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ips_license_host_unique" UNIQUE("license_id","ip")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"notes" text,
	"key_format" jsonb,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY,
	"key_hash" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"user_id" uuid,
	"item_id" uuid,
	"expires_at" timestamp with time zone,
	"device_limit" integer,
	"ip_limit" integer,
	"allowed_ips" inet[] DEFAULT '{}'::inet[] NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"notes" text,
	"key_format" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_device_limit_nonnegative" CHECK ("device_limit" >= 0),
	CONSTRAINT "licenses_ip_limit_nonnegative" CHECK ("ip_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "license_meters" (
	"id" uuid PRIMARY KEY,
	"license_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" numeric DEFAULT '0' NOT NULL,
	"limit" numeric NOT NULL,
	"allow_overage" boolean DEFAULT false NOT NULL,
	"numeric_mode" text DEFAULT 'integer' NOT NULL,
	"precision" integer DEFAULT 0 NOT NULL,
	"schedule" jsonb,
	"next_reset_at" timestamp with time zone,
	"last_scheduled_reset_at" timestamp with time zone,
	"last_reset_at" timestamp with time zone,
	CONSTRAINT "meters_license_name_unique" UNIQUE("license_id","name"),
	CONSTRAINT "meters_numeric_bounds" CHECK ("precision" between 0 and 6 and "numeric_mode" in ('integer', 'decimal') and ("numeric_mode" <> 'integer' or "precision" = 0) and "value" >= 0 and "limit" >= 0 and "value" < power(10::numeric, 15 - "precision") and "limit" < power(10::numeric, 15 - "precision") and scale(trim_scale("value")) <= "precision" and scale(trim_scale("limit")) <= "precision")
);
--> statement-breakpoint
CREATE TABLE "idempotency_receipts" (
	"operation" text,
	"principal_id" text,
	"key" text,
	"fingerprint" text NOT NULL,
	"secret_issued" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_receipts_pkey" PRIMARY KEY("operation","principal_id","key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY,
	"value" jsonb NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audits_time_idx" ON "audit_logs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "audits_target_idx" ON "audit_logs" ("target_id");--> statement-breakpoint
CREATE INDEX "deliveries_claim_idx" ON "webhook_deliveries" ("state","created_at");--> statement-breakpoint
CREATE INDEX "deliveries_webhook_idx" ON "webhook_deliveries" ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "licenses_user_idx" ON "licenses" ("user_id");--> statement-breakpoint
CREATE INDEX "licenses_item_idx" ON "licenses" ("item_id");--> statement-breakpoint
CREATE INDEX "licenses_expiry_idx" ON "licenses" ("expires_at");--> statement-breakpoint
CREATE INDEX "receipts_expiry_idx" ON "idempotency_receipts" ("expires_at");--> statement-breakpoint
ALTER TABLE "license_hardware_ids" ADD CONSTRAINT "license_hardware_ids_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_ip_ids" ADD CONSTRAINT "license_ip_ids_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_item_id_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "license_meters" ADD CONSTRAINT "license_meters_license_id_licenses_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE;