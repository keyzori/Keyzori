DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "ApiKey"
		WHERE "limitIp" < 0
			OR "limitHwid" < 0
			OR "limitConcurrent" < 0
			OR "limitUsage" < 0
			OR "trialDurationMin" < 0
	) THEN
		RAISE EXCEPTION 'Cannot add non-negative license constraints: ApiKey contains negative legacy limit values. Repair those rows explicitly and rerun the migration.';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_limitIp_nonnegative" CHECK ("limitIp" >= 0);--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_limitHwid_nonnegative" CHECK ("limitHwid" >= 0);--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_limitConcurrent_nonnegative" CHECK ("limitConcurrent" >= 0);--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_limitUsage_nonnegative" CHECK ("limitUsage" >= 0);--> statement-breakpoint
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_trialDurationMin_nonnegative" CHECK ("trialDurationMin" >= 0);
