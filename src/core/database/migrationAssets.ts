import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "migrations");

export const migrationAssets = readdirSync(directory, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort()
	.map((name) => {
		if (!/^\d{14}_/.test(name))
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
		return {
			name,
			hash: new Bun.CryptoHasher("sha256").update(contents).digest("hex"),
			folderMillis,
			bps: true,
			sql: contents.split("--> statement-breakpoint"),
		};
	});

if (migrationAssets.length === 0)
	throw new Error("No database migrations found");
