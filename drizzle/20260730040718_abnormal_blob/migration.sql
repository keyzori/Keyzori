CREATE TABLE "AccessAttempt" (
	"id" text PRIMARY KEY,
	"apiKeyId" text NOT NULL,
	"ip" text NOT NULL,
	"hwid" text NOT NULL,
	"attemptCount" integer DEFAULT 1 NOT NULL,
	"firstAttemptedAt" timestamp(3) DEFAULT now() NOT NULL,
	"lastAttemptedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "AccessAttempt_apiKeyId_ip_hwid_key" ON "AccessAttempt" ("apiKeyId","ip","hwid");--> statement-breakpoint
ALTER TABLE "AccessAttempt" ADD CONSTRAINT "AccessAttempt_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;