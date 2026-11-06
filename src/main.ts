import { Config } from "./core/config/Config";
import { KeyGenerator } from "./core/security/KeyGenerator";
import { healthcheckUrl } from "./core/http/healthcheckUrl";
import { version } from "./version";

async function run() {
	const command = Bun.argv[2] ?? "serve";
	let phase = "configuration";
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
		} else if (command === "migrate" || command === "prepare-restore") {
			if (
				command === "prepare-restore" &&
				(Bun.argv[3] !== "--confirm-restored-database" || Bun.argv.length !== 4)
			)
				throw new Error(
					"Restore preparation requires explicit restored-database confirmation",
				);
			const config = Config.database(Bun.env, true);
			const { Database } = await import("./core/database/Database");
			const { MigrationService } = await import(
				"./core/database/MigrationService"
			);
			const database = new Database(config.databaseUrl, config.poolSize);
			try {
				if (command === "migrate") {
					phase = "migration";
					await new MigrationService(database).run();
				} else {
					phase = "restore";
					const { RestoreService } = await import(
						"./core/database/RestoreService"
					);
					console.log(
						JSON.stringify({
							event: "restore.prepared",
							...(await new RestoreService(database).prepare()),
						}),
					);
				}
			} finally {
				await database.close();
			}
		} else if (command === "serve") {
			const { ServerLifecycle } = await import("./core/ServerLifecycle");
			const lifecycle = new ServerLifecycle(new Config());
			const shutdown = () => {
				void lifecycle.stop().then(
					() => process.exit(0),
					() => {
						console.error(
							JSON.stringify({
								event: "shutdown.failed",
								code: "SHUTDOWN_FAILED",
							}),
						);
						process.exit(1);
					},
				);
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
			phase = "startup";
			await lifecycle.start();
			return lifecycle.app;
		} else throw new Error("Unknown command");
	} catch (error) {
		const errorClass = error instanceof Error ? error.name : "UnknownError";
		const setting =
			error instanceof Error
				? error.message.match(/^KZ_[A-Z0-9_]+\b/)?.[0]
				: undefined;
		const category = setting
			? "INVALID_CONFIGURATION"
			: error instanceof Error &&
					/migration history|fresh database|No database migrations/.test(
						error.message,
					)
				? "SCHEMA_INCOMPATIBLE"
				: error instanceof Error &&
						error.message === "PostgreSQL 17 or later is required"
					? "UNSUPPORTED_DATABASE_VERSION"
					: "COMMAND_FAILED";
		const sqlState =
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string" &&
			/^[0-9A-Z]{5}$/.test(error.code)
				? error.code
				: undefined;
		console.error(
			JSON.stringify({
				event: "command.failed",
				command: [
					"version",
					"--version",
					"master-key",
					"healthcheck",
					"migrate",
					"prepare-restore",
					"serve",
				].includes(command)
					? command
					: "unknown",
				phase,
				errorClass,
				category,
				setting,
				sqlState,
				message:
					"Check configuration, database migration history and dependency availability.",
			}),
		);
		process.exitCode = 1;
	}
}

export const app = await run();
