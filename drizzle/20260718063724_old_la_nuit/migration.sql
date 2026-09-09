DO $$ BEGIN
	CREATE TYPE "KeyType" AS ENUM('PERPETUAL', 'SUBSCRIPTION', 'USAGE');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ApiKey" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL UNIQUE,
	"userId" text NOT NULL,
	"type" "KeyType" DEFAULT 'PERPETUAL'::"KeyType" NOT NULL,
	"limitIp" integer DEFAULT 0 NOT NULL,
	"limitHwid" integer DEFAULT 0 NOT NULL,
	"limitConcurrent" integer DEFAULT 0 NOT NULL,
	"limitUsage" integer DEFAULT 0 NOT NULL,
	"trialDurationMin" integer DEFAULT 0 NOT NULL,
	"firstActivatedAt" timestamp(3),
	"customFields" jsonb DEFAULT '{}' NOT NULL,
	"expiresAt" timestamp(3),
	"revoked" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "HwidWhitelist" (
	"id" text PRIMARY KEY,
	"apiKeyId" text NOT NULL,
	"hwid" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "IpWhitelist" (
	"id" text PRIMARY KEY,
	"apiKeyId" text NOT NULL,
	"ip" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "KeyDeviceMapping" (
	"id" text PRIMARY KEY,
	"apiKeyId" text NOT NULL,
	"registeredDeviceId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "RegisteredDevice" (
	"id" text PRIMARY KEY,
	"ip" text NOT NULL,
	"hwid" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "User" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_key_key" ON "ApiKey" ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "HwidWhitelist_apiKeyId_hwid_key" ON "HwidWhitelist" ("apiKeyId","hwid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "IpWhitelist_apiKeyId_ip_key" ON "IpWhitelist" ("apiKeyId","ip");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "KeyDeviceMapping_apiKeyId_registeredDeviceId_key" ON "KeyDeviceMapping" ("apiKeyId","registeredDeviceId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "RegisteredDevice_ip_hwid_key" ON "RegisteredDevice" ("ip","hwid");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "HwidWhitelist" ADD CONSTRAINT "HwidWhitelist_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "IpWhitelist" ADD CONSTRAINT "IpWhitelist_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "KeyDeviceMapping" ADD CONSTRAINT "KeyDeviceMapping_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "KeyDeviceMapping" ADD CONSTRAINT "KeyDeviceMapping_registeredDeviceId_fkey" FOREIGN KEY ("registeredDeviceId") REFERENCES "RegisteredDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
