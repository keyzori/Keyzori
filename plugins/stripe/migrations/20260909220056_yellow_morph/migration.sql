CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"eventId" text NOT NULL UNIQUE,
	"eventType" text NOT NULL,
	"subscriptionId" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim" uuid,
	"leaseUntil" timestamp with time zone,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	CONSTRAINT "stripe_event_state" CHECK ("state" IN ('pending', 'processing', 'completed')),
	CONSTRAINT "stripe_event_attempts" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"licenseId" uuid NOT NULL UNIQUE,
	"subscriptionId" text NOT NULL UNIQUE,
	"customerId" text NOT NULL,
	"status" text NOT NULL,
	"syncedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "stripe_event_work_idx" ON "stripe_events" ("state","nextAttemptAt");--> statement-breakpoint
ALTER TABLE "stripe_links" ADD CONSTRAINT "stripe_links_licenseId_licenses_id_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("id") ON DELETE RESTRICT;