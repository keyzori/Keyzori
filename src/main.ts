import { Manifest } from "elysia";
import { Config } from "./core/config/Config";
import { ServerLifecycle } from "./core/ServerLifecycle";
import { Database } from "./core/database/Database";
import { MigrationService } from "./core/database/MigrationService";
import { KeyGenerator } from "./core/security/KeyGenerator";
import { healthcheckUrl } from "./core/http/healthcheckUrl";
import { version } from "./version";

async function run() {
	const command = Bun.argv[2] ?? "serve";
	try {
		if (command === "version" || command === "--version") console.log(version);
		else if (command === "master-key") console.log(new KeyGenerator().master());
		else if (command === "healthcheck") {
			const port = Bun.env.KZ_API_PORT ?? "6284";
			if (!/^[1-9][0-9]*$/.test(port)) throw new Error("Invalid port");
			const response = await fetch(
				healthcheckUrl({
					host: Bun.env.KZ_API_HOST ?? "0.0.0.0",
					port: Number(port),
				}),
				{
					signal: AbortSignal.timeout(4000),
					redirect: "error",
				},
			);
			if (!response.ok) process.exitCode = 1;
		} else if (command === "migrate") {
			const config = new Config();
			const database = new Database(config.databaseUrl, config.poolSize);
			try {
				await new MigrationService(database).run();
			} finally {
				await database.close();
			}
		} else if (command === "serve") {
			const lifecycle = new ServerLifecycle(new Config());
			process.once("SIGINT", () => {
				void lifecycle.stop().then(() => process.exit(0));
			});
			process.once("SIGTERM", () => {
				void lifecycle.stop().then(() => process.exit(0));
			});
			await lifecycle.start();
			return lifecycle.app;
		} else throw new Error("Unknown command");
	} catch {
		console.error(
			"Keyzori could not complete the command. Check configuration and dependency availability.",
		);
		process.exitCode = 1;
	}
}

export const app = Manifest.isCapturing()
	? (await import("./scripts/capture")).app
	: await run();
