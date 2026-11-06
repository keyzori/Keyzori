DROP INDEX "licenses_group_idx";--> statement-breakpoint
CREATE INDEX "licenses_group_created_idx" ON "licenses" ("group_id","created_at","id");