import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "migrations");

export const migrationAssets = readdirSync(directory, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort()
	.map((name) => {
		if (!/^\d{14}_[a-z0-9_]+$/.test(name))
			throw new Error(`Invalid migration name: ${name}`);
		const contents = readFileSync(
			join(directory, name, "migration.sql"),
			"utf8",
		).replaceAll("\r\n", "\n");
		const date = name.slice(0, 14);
		const folderMillis = Date.UTC(
			Number(date.slice(0, 4)),
			Number(date.slice(4, 6)) - 1,
			Number(date.slice(6, 8)),
			Number(date.slice(8, 10)),
			Number(date.slice(10, 12)),
			Number(date.slice(12, 14)),
		);
		if (
			new Date(folderMillis)
				.toISOString()
				.replace(/[-:T]/g, "")
				.slice(0, 14) !== date
		)
			throw new Error(`Invalid migration timestamp: ${name}`);
		const statements = contents
			.split("--> statement-breakpoint")
			.filter((statement) => statement.trim());
		if (statements.length === 0) throw new Error(`Empty migration: ${name}`);
		return Object.freeze({
			name,
			hash: new Bun.CryptoHasher("sha256").update(contents).digest("hex"),
			folderMillis,
			sql: Object.freeze(statements),
		});
	});

if (migrationAssets.length === 0)
	throw new Error("No database migrations found");

for (let index = 1; index < migrationAssets.length; index++) {
	const previous = migrationAssets[index - 1];
	const current = migrationAssets[index];
	if (previous && current && current.folderMillis <= previous.folderMillis)
		throw new Error(
			"Database migrations must have distinct increasing timestamps",
		);
}
Object.freeze(migrationAssets);

/** A safe restore/preflight checkpoint, independent of credentials and database contents. */
export const migrationFingerprint = new Bun.CryptoHasher("sha256")
	.update(
		JSON.stringify(
			migrationAssets.map(({ name, hash, folderMillis }) => [
				name,
				hash,
				folderMillis,
			]),
		),
	)
	.digest("hex");
