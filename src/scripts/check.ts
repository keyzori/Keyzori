import { doctor } from "./doctor";

const args = Bun.argv.slice(2);
if (args.some((arg) => arg !== "--types"))
	throw new Error("Use bun check or bun check --types");
const typesOnly = args.includes("--types");
// A narrow diagnostic remains available even before the pinned runtime is installed.
if (!typesOnly) await doctor();
for (const script of typesOnly
	? ["typecheck"]
	: ["typecheck", "lint", "format:check", "db:check", "test"]) {
	const child = Bun.spawn([process.execPath, "run", script], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code !== 0) {
		process.exitCode = code;
		break;
	}
}
