import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const operation = process.argv[2];
if (!["install", "generate", "check"].includes(operation ?? ""))
	throw new Error("Expected install, generate, or check.");
const root = resolve(import.meta.dir, "..");
for (const entry of (
	await readdir(join(root, "plugins"), { withFileTypes: true })
).sort((a, b) => a.name.localeCompare(b.name))) {
	if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name))
		continue;
	const cwd = join(root, "plugins", entry.name);
	if (operation === "install" && existsSync(join(cwd, "package.json"))) {
		const child = Bun.spawn(
			[
				process.execPath,
				"install",
				"--frozen-lockfile",
				...(process.argv.includes("--production")
					? ["--production", "--ignore-scripts"]
					: []),
			],
			{ cwd, stdout: "inherit", stderr: "inherit" },
		);
		if (await child.exited)
			throw new Error(`Dependency install failed for ${entry.name}.`);
	} else if (
		operation !== "install" &&
		existsSync(join(cwd, "drizzle.config.ts"))
	) {
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				join(root, "node_modules/drizzle-kit/bin.cjs"),
				operation ?? "check",
			],
			{ cwd, stdout: "inherit", stderr: "inherit" },
		);
		if (await child.exited)
			throw new Error(`Migration ${operation} failed for ${entry.name}.`);
	}
}
