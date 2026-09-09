#!/usr/bin/env bun
import { createProgram } from "./cli";
import { runHealthcheck, startServer } from "./index";

async function main(): Promise<void> {
	const [command = "serve", ...args] = process.argv.slice(2);
	switch (command) {
		case "serve":
			await startServer();
			return;
		case "admin":
			await createProgram().parseAsync(["bun", "keyzori admin", ...args]);
			return;
		case "healthcheck":
			await runHealthcheck();
			return;
		default:
			throw new Error(
				`Unknown command ${JSON.stringify(command)}. Use serve, admin, or healthcheck.`,
			);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
