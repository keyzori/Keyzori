import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const migrate = mock(async () => {});
mock.module("drizzle-orm/bun-sql/postgres/migrator", () => ({ migrate }));

import { db } from "../db";
import { migrateDatabase } from "../db/migrate";

const migrationsFolder = join(import.meta.dir, "../../drizzle");

describe("migrateDatabase", () => {
	let previousPath: string | undefined;

	beforeAll(() => {
		previousPath = Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH;
		Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH = migrationsFolder;
	});

	afterAll(() => {
		if (previousPath === undefined)
			delete Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH;
		else Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH = previousPath;
	});

	test("uses the configured migrations folder", async () => {
		await migrateDatabase();
		expect(migrate).toHaveBeenCalledWith(db, {
			migrationsFolder,
		});
	});

	test("fails clearly when no migrations folder exists", async () => {
		const originalDirectory = process.cwd();
		const emptyDirectory = mkdtempSync(join(tmpdir(), "keyzori-migrations-"));
		Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH = join(emptyDirectory, "missing");
		process.chdir(emptyDirectory);
		try {
			await expect(migrateDatabase()).rejects.toThrow(
				"Drizzle migrations folder was not found",
			);
		} finally {
			process.chdir(originalDirectory);
			rmSync(emptyDirectory, { recursive: true, force: true });
		}
	});

	test("preserves legacy licenses while migrating canonical tables and types", () => {
		const folder = readdirSync(migrationsFolder).find((entry) =>
			entry.endsWith("_licensing_overhaul"),
		);
		if (!folder) throw new Error("Licensing overhaul migration was not found");
		const migration = readFileSync(
			join(migrationsFolder, folder, "migration.sql"),
			"utf8",
		);
		expect(migration).toContain('ALTER TABLE "ApiKey" RENAME TO "licenses"');
		expect(migration).toContain(
			'ALTER TABLE "licenses" DROP COLUMN IF EXISTS "key"',
		);
		expect(migration).toContain('ADD COLUMN "session_revision" integer');
		expect(migration).toContain('SET "ip" = host("ip"::inet)');
		expect(migration).toContain(
			'DROP INDEX IF EXISTS "IpWhitelist_apiKeyId_ip_key"',
		);
		expect(migration).toContain('PARTITION BY "license_id", "ip"');
		expect(migration).toContain(
			'SELECT DISTINCT ON (m."apiKeyId", host(d."ip"::inet), d."hwid")',
		);
		expect(migration).toContain("WHEN \"trialDurationMin\" > 0 THEN 'trial'");
		expect(migration).toContain('WHERE "limitUsage" > 0');
		expect(migration).toContain("'legacy-usage-' || \"id\"");
		expect(migration).toContain("jsonb_build_object('attemptCount'");
		expect(migration).toContain('DROP TABLE "AccessAttempt"');
		expect(migration).toContain('DROP TYPE "KeyType"');
	});

	test("creates durable metering, activity, and Stripe inbox storage", () => {
		const folder = readdirSync(migrationsFolder).find((entry) =>
			entry.endsWith("_licensing_overhaul"),
		);
		if (!folder) throw new Error("Licensing overhaul migration was not found");
		const migration = readFileSync(
			join(migrationsFolder, folder, "migration.sql"),
			"utf8",
		);
		for (const table of [
			"license_meters",
			"usage_ledger_entries",
			"activity_events",
			"activity_totals",
			"activity_minute_buckets",
			"stripe_subscription_links",
			"stripe_webhook_events",
		]) {
			expect(migration).toContain(`CREATE TABLE "${table}"`);
		}
		expect(migration).toContain('"stripe_customer_id" text NOT NULL');
	});
});
