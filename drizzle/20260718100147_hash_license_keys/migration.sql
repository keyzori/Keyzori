ALTER TABLE "ApiKey" ALTER COLUMN "key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "keyHash" text;--> statement-breakpoint
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "keyPrefix" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_keyHash_key" UNIQUE("keyHash");
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
