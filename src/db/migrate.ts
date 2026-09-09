import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sql/postgres/migrator";
import { db } from ".";

function findMigrationsFolder(): string {
	const configured = Bun.env.KEYZORI_DRIZZLE_MIGRATIONS_PATH;
	const candidates = [
		configured,
		resolve(dirname(process.execPath), "drizzle"),
		resolve(process.cwd(), "drizzle"),
		resolve(process.cwd(), "drizzle"),
	].filter((candidate): candidate is string => Boolean(candidate));

	const folder = candidates.find(existsSync);
	if (!folder) {
		throw new Error(
			"Drizzle migrations folder was not found. Set KEYZORI_DRIZZLE_MIGRATIONS_PATH.",
		);
	}
	return folder;
}

export async function migrateDatabase(): Promise<void> {
	await migrate(db, { migrationsFolder: findMigrationsFolder() });
}
