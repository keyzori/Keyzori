import { join } from "node:path";
import { Services } from "./Services.ts";
import type { Config } from "../shared/Config.ts";
import { createHttp } from "./http.ts";
import { MigrationRunner } from "../database/MigrationRunner.ts";
import { PluginLoader } from "../plugins/PluginLoader.ts";
import type { PluginContext } from "../plugins/contract.ts";

export class Application {
	readonly services;
	readonly state = { ready: false };
	readonly app;
	readonly context: PluginContext;
	private started = false;
	private stopping: Promise<void> | undefined;
	private maintenance: ReturnType<typeof setInterval> | undefined;
	private maintenanceWork = Promise.resolve();
	constructor(
		readonly config: Config,
		readonly root: string,
	) {
		this.services = new Services(config);
		const { app, guard } = createHttp(config, this.services, this.state);
		this.app = app;
		this.context = {
			database: this.services.database,
			redis: this.services.redis,
			services: this.services,
			env: config.env,
			logger: this.services.logger,
			adminGuard: guard,
		};
	}
	async migrate() {
		if (this.started || this.stopping)
			throw new Error("Application lifecycle cannot be started twice.");
		this.started = true;
		try {
			const plugins = await new PluginLoader(join(this.root, "plugins")).load(
				this.config.plugins,
				this.context,
				this.app,
			);
			await new MigrationRunner(this.services.database, this.root).run(plugins);
		} finally {
			await this.stop();
		}
	}
	async start() {
		if (this.started || this.stopping)
			throw new Error("Application lifecycle cannot be started twice.");
		this.started = true;
		try {
			const loader = new PluginLoader(join(this.root, "plugins"));
			const plugins = await loader.load(
				this.config.plugins,
				this.context,
				this.app,
			);
			await this.services.connect();
			await new MigrationRunner(this.services.database, this.root).run(plugins);
			loader.mount(this.app, plugins);
			await this.services.activity.prune();
			// Elysia's Bun adapter does not await lifecycle promises. Run hooks here
			// so initialization failures precede listen and cleanup precedes DB close.
			const startHooks = this.app.event.start?.splice(0) ?? [];
			for (const hook of startHooks) await hook.fn(this.app);
			this.state.ready = true;

			this.app.listen({ hostname: this.config.host, port: this.config.port });

			let lastPrune = Date.now();
			let running = false;
			this.maintenance = setInterval(() => {
				if (running) return;
				running = true;
				this.maintenanceWork = (async () => {
					if (!this.services.redis.connected)
						await this.services.redis.connect();
					await this.services.redis.send("PING", []);
					if (Date.now() - lastPrune >= 86400000) {
						await this.services.activity.prune();
						lastPrune = Date.now();
					}
				})()
					.catch(() =>
						this.services.logger.error("maintenance.dependency_unavailable"),
					)
					.finally(() => {
						running = false;
					});
			}, 1000);
			return this;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}
	stop() {
		this.stopping ??= this.shutdown();
		return this.stopping;
	}
	private async shutdown() {
		this.state.ready = false;
		if (this.maintenance) clearInterval(this.maintenance);
		const hooks = this.app.event.stop?.splice(0) ?? [];
		try {
			if (this.app.server) await this.app.stop();
			await this.maintenanceWork;
			const results = await Promise.allSettled(
				hooks.map((hook) => Promise.resolve().then(() => hook.fn(this.app))),
			);
			if (results.some((result) => result.status === "rejected")) {
				this.services.logger.error("plugin.cleanup_failed");
				throw new Error("Plugin cleanup failed.");
			}
		} finally {
			await this.services.close();
		}
	}
}
