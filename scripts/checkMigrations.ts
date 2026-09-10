import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

const root = resolve(import.meta.dir, "..");
const directories = [join(root, "migrations")];
for (const entry of await readdir(join(root, "plugins"), {
	withFileTypes: true,
}))
	if (
		entry.isDirectory() &&
		existsSync(join(root, "plugins", entry.name, "migrations"))
	)
		directories.push(join(root, "plugins", entry.name, "migrations"));
for (const directory of directories) {
	const migrations = readMigrationFiles({ migrationsFolder: directory });
	if (!migrations.length) throw new Error(`No migrations: ${directory}`);
	for (const migration of migrations) {
		if (
			!/^\d{14}_[a-z0-9_]+$/.test(migration.name ?? "") ||
			!Number.isFinite(migration.folderMillis)
		)
			throw new Error("Invalid RC migration directory.");
		if (!existsSync(join(directory, migration.name ?? "", "snapshot.json")))
			throw new Error("Migration snapshot is missing.");
	}
}
const manifest = await Bun.file(join(root, "package.json")).json();
if (
	manifest.dependencies["drizzle-orm"] !== "1.0.0-rc.5-ab785fc" ||
	manifest.devDependencies["drizzle-kit"] !==
		manifest.dependencies["drizzle-orm"]
)
	throw new Error("Drizzle ORM and Kit must retain matching verified RC pins.");
for (const directory of ["src", "plugins", "scripts", "tests"]) {
	for await (const file of new Bun.Glob("**/*.ts").scan({
		cwd: join(root, directory),
	})) {
		if (file.replaceAll("\\", "/").split("/").includes("node_modules"))
			continue;
		if (
			(await Bun.file(join(root, directory, file)).text()).trimEnd().split("\n")
				.length >= 500
		)
			throw new Error(
				`Authored file must stay below 500 lines: ${directory}/${file}`,
			);
	}
}
for await (const file of new Bun.Glob("**/*.ts").scan({
	cwd: join(root, "src"),
}))
	if (/stripe/i.test(await Bun.file(join(root, "src", file)).text()))
		throw new Error(`Core contains plugin-specific code: ${file}`);
console.log(
	"Migration format, dependency pins, plugin isolation, and source size verified.",
);
