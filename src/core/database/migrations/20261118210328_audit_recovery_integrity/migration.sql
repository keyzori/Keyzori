-- Publication used to bootstrap on first serve. An absent checkpoint is safe to
-- initialize only if no application work survives, including pruned-event tombstones.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM public.event_state) THEN
		PERFORM pg_advisory_xact_lock(6284, 1);
		IF NOT EXISTS (SELECT FROM public.event_state) THEN
			IF EXISTS (SELECT FROM public.activity_events) OR EXISTS (SELECT FROM public.event_resources)
				OR EXISTS (SELECT FROM public.webhooks) OR EXISTS (SELECT FROM public.webhook_deliveries)
				OR EXISTS (SELECT FROM public.webhook_delivery_attempts) OR EXISTS (SELECT FROM public.audit_logs)
				OR EXISTS (SELECT FROM public.usage_operations) OR EXISTS (SELECT FROM public.idempotency_receipts)
				OR EXISTS (SELECT FROM public.api_keys) OR EXISTS (SELECT FROM public.api_key_groups)
				OR EXISTS (SELECT FROM public.groups) OR EXISTS (SELECT FROM public.users) OR EXISTS (SELECT FROM public.licenses)
				OR EXISTS (SELECT FROM public.license_meters) OR EXISTS (SELECT FROM public.maintenance_reset_retries)
				OR EXISTS (SELECT FROM public.license_hardware_ids) OR EXISTS (SELECT FROM public.license_ip_ids)
				OR EXISTS (SELECT FROM public.settings)
				OR (SELECT is_called FROM public.activity_events_ordinal_seq)
				OR (SELECT is_called FROM public.license_hardware_ids_registration_order_seq)
				OR (SELECT is_called FROM public.license_ip_ids_registration_order_seq)
			THEN
				RAISE EXCEPTION 'Missing publication checkpoint on a nonempty database' USING ERRCODE = '55000';
			END IF;
			INSERT INTO public.event_state (id, epoch) VALUES (1, gen_random_uuid());
		END IF;
	END IF;
END $$;
--> statement-breakpoint
DROP INDEX "deliveries_retention_idx";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "grant_generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "terminal_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "idempotency_receipts" ADD COLUMN "version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "staged_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "staged_signing_key_id" uuid;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "dispatch_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "dispatch_retry_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
-- The old schema did not record a trustworthy terminal instant. Retain a full
-- review interval from this upgrade; only unfinished sends need a signing snapshot.
UPDATE public.webhook_deliveries SET terminal_at = statement_timestamp(), secret_ciphertext = NULL
WHERE state IN ('succeeded','failed','cancelled');
--> statement-breakpoint
CREATE INDEX "deliveries_terminal_retention_idx" ON "webhook_deliveries" ("terminal_at","id") WHERE "state" in ('succeeded','failed','cancelled');--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "deliveries_terminal_check" CHECK (("state" in ('succeeded','failed','cancelled')) = ("terminal_at" is not null) and (("terminal_at" is null) = ("secret_ciphertext" is not null)));--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_staged_key_check" CHECK (("staged_signing_key_id" is null) = ("staged_secret_ciphertext" is null) and "staged_signing_key_id" is distinct from "signing_key_id");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_dispatch_retry_check" CHECK ("dispatch_failures" between 0 and 6 and (("dispatch_failures" = 0) = ("dispatch_retry_at" is null)));
