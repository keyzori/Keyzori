import { resolve } from "node:path";
import { CommanderError } from "commander";
import { Config } from "./shared/Config.ts";
import { AppError } from "./shared/errors.ts";
import { createLogger } from "./shared/logging.ts";
import { redact } from "./shared/security.ts";

const root = resolve(import.meta.dir, "..");
const logger = createLogger();
async function main() {
	const [command = "serve", ...args] = process.argv.slice(2);
	if (command === "admin") {
		const { Cli } = await import("./cli/Cli.ts");
		await new Cli(process.env, root).run(args);
	} else if (command === "migrate") {
		const { Application } = await import("./application/Application.ts");
		await new Application(new Config(process.env), root).migrate();
		logger.notif("Migrations complete.", { name: "migrate" });
	} else if (command === "serve") {
		const { Application } = await import("./application/Application.ts");
		const application = await new Application(
			new Config(process.env),
			root,
		).start();
		for (const signal of ["SIGTERM", "SIGINT"] as const)
			process.once(signal, () => {
				void application.stop().catch(() => {
					process.exitCode = 1;
				});
			});
		application.services.logger.notif(
			`Listening on ${application.config.host}:${application.app.server?.port ?? application.config.port}\nPlugins: ${application.config.plugins.join(", ") || "none"}`,
			{
				layout: "box",
				box: {
					topRight: "Keyzori",
					bottomLeft: "ready",
					bottomRight: `Bun ${Bun.version}`,
				},
			},
		);
	} else if (command === "healthcheck") {
		const url =
			process.env.KEYZORI_URL ??
			`http://127.0.0.1:${process.env.KEYZORI_PORT ?? 3000}`;
		const response = await fetch(new URL("/ready", url), {
			signal: AbortSignal.timeout(5000), // needs tweaking
			redirect: "error",
		});
		if (!response.ok) throw new Error("Server is not ready.");
		process.stdout.write("ready\n"); // might remove?
	} else if (["--help", "-h"].includes(command))
		process.stdout.write(
			"bun src/main.ts <serve | migrate | admin | healthcheck>\n",
		);
	else throw new Error("Expected serve, migrate, admin, or healthcheck.");
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		if (error instanceof CommanderError && error.exitCode === 0)
			process.exitCode = 0;
		else {
			logger.error(
				error instanceof AppError
					? `${error.code}: ${String(redact(error.message))}`
					: error instanceof Error && !error.message.includes("://")
						? String(redact(error.message))
						: "Command failed. Check configuration and service availability.",
			);
			process.exitCode = 1;
		}
	}
}
