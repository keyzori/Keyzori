UPDATE "ApiKey"
SET
	"keyHash" = encode(sha256(convert_to("key", 'UTF8')), 'hex'),
	"keyPrefix" = left("key", 12)
WHERE "keyHash" IS NULL AND "key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_key_key";--> statement-breakpoint
ALTER TABLE "ApiKey" ALTER COLUMN "keyHash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiKey" ALTER COLUMN "keyPrefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiKey" DROP COLUMN "key";
