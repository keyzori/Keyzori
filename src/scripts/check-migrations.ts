import { cp, mkdtemp, rm } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { migrationAssets } from "../core/database/migrationAssets";

const root = resolve(".cache");
await Bun.write(join(root, ".keep"), "");
const temporary = await mkdtemp(join(root, "migrations-"));
const output = join(temporary, "migrations");
const path = relative(root, temporary);
if (path.startsWith("..") || !path.startsWith("migrations-"))
	throw new Error("Unsafe temporary migration path");
try {
	const source = resolve("src/core/database/migrations");
	await cp(source, output, { recursive: true });
	const config = join(temporary, "drizzle.config.ts");
	await Bun.write(
		config,
		`export default { dialect: "postgresql", schema: "./src/core/database/schema/*.ts", out: ${JSON.stringify(output)} };\n`,
	);
	const before = await Array.fromAsync(
		new Bun.Glob("*/migration.sql").scan({ cwd: output }),
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"x",
			"--bun",
			"drizzle-kit",
			"generate",
			`--config=${config}`,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if ((await child.exited) !== 0)
		throw new Error("Migration generation check failed");
	const after = await Array.fromAsync(
		new Bun.Glob("*/migration.sql").scan({ cwd: output }),
	);
	if (
		JSON.stringify(before.sort()) !== JSON.stringify(after.sort()) ||
		before.length !== migrationAssets.length
	)
		throw new Error("Schema differs from committed migrations");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
