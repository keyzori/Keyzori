ALTER TABLE "webhook_deliveries" ADD COLUMN "required_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "requires_all_groups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "required_group_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "requires_all_groups" boolean DEFAULT false NOT NULL;