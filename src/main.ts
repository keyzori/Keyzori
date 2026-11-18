import { Config, ConfigError } from "./core/config/Config";
import { KeyGenerator } from "./core/security/KeyGenerator";
import { healthcheckUrl } from "./core/http/healthcheckUrl";
import { version } from "./version";
import { Logger } from "./core/observability/Logger";
import { healthBudgets } from "./plugins/health/budgets";

async function run() {
	const command = Bun.argv[2] ?? "serve";
	let phase = "configuration";
	let signalled = false;
	try {
		if (command === "version" || command === "--version") console.log(version);
		else if (command === "master-key") console.log(new KeyGenerator().master());
		else if (command === "healthcheck") {
			const listener = Config.listener();
			phase = "healthcheck";
			const response = await fetch(healthcheckUrl(listener), {
				signal: AbortSignal.timeout(healthBudgets.cliMs),
				redirect: "error",
			});
			if (!response.ok) process.exitCode = 1;
		} else if (command === "migrate" || command === "prepare-restore") {
			if (
				command === "prepare-restore" &&
				(Bun.argv[3] !== "--confirm-restored-database" || Bun.argv.length !== 4)
			)
				throw new Error(
					"Restore preparation requires explicit restored-database confirmation",
				);
			const config = Config.database(
				Bun.env,
				command === "prepare-restore" ? "restore" : true,
			);
			const { Database } = await import("./core/database/Database");
			const { MigrationService } =
				await import("./core/database/MigrationService");
			const database = new Database(config.databaseUrl, config.poolSize);
			try {
				if (command === "migrate") {
					phase = "migration";
					await new MigrationService(database).run();
				} else {
					phase = "restore";
					const { RestoreService } =
						await import("./core/database/RestoreService");
					console.log(
						JSON.stringify({
							event: "restore.prepared",
							...(await new RestoreService(database).prepare()),
						}),
					);
				}
			} catch (error) {
				await database.close().catch((cleanup: unknown) => {
					console.error(
						JSON.stringify({
							event: "command.cleanup.failed",
							phase,
							cause: Logger.cause(cleanup),
						}),
					);
				});
				throw error;
			}
			await database.close();
		} else if (command === "serve") {
			const { ServerLifecycle, ShutdownError } =
				await import("./core/ServerLifecycle");
			const lifecycle = new ServerLifecycle(new Config());
			const shutdown = () => {
				if (signalled) return;
				signalled = true;
				void lifecycle.stop().then(
					() => process.exit(0),
					(error: unknown) =>
						process.exit(
							error instanceof ShutdownError && error.code === "FORCED_SHUTDOWN"
								? 2
								: 1,
						),
				);
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			phase = "startup";
			try {
				await lifecycle.start();
			} catch (error) {
				if (signalled) return; // The signal handler owns the bounded shutdown result.
				phase = lifecycle.startupPhase;
				throw error;
			}
			return lifecycle.app;
		} else throw new Error("Unknown command");
	} catch (error) {
		const cause = Logger.cause(error);
		const setting = error instanceof ConfigError ? error.setting : undefined;
		const category = cause === "UNEXPECTED_ERROR" ? "COMMAND_FAILED" : cause;
		const sqlState = cause.startsWith("SQLSTATE_") ? cause.slice(9) : undefined;
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
				category,
				setting,
				sqlState,
				message:
					"Check configuration, database migration history and dependency availability.",
			}),
		);
		process.exitCode = 1;
		if (command === "serve") process.exit(1);
	}
}

export const app = await run();
