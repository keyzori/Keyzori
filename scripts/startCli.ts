import { existsSync } from "node:fs";
import { resolve } from "node:path";

const appDirectory = resolve(import.meta.dir, "..");
const executable = resolve(
	appDirectory,
	"dist",
	process.platform === "win32" ? "keyzori.exe" : "keyzori",
);

if (!existsSync(executable)) {
	console.error("CLI binary is missing. Run `bun run build:server` first.");
	process.exit(1);
}

const cli = Bun.spawn([executable, "admin", ...process.argv.slice(2)], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	env: Bun.env,
});

process.exit(await cli.exited);
