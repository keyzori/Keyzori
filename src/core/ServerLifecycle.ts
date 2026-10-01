import { createApp } from "../app";
import { ServerServices } from "./ServerServices";
import { MigrationService } from "./database/MigrationService";
import { MaintenanceService } from "./MaintenanceService";
import type { Config } from "./config/Config";

export class ServerLifecycle {
	readonly services;
	readonly app;
	private cron?: Bun.CronJob;
	private dispatchTimer?: ReturnType<typeof setInterval>;
	private dispatching = false;
	private maintenancePass: Promise<unknown> = Promise.resolve();
	private closing?: Promise<void>;
	constructor(private readonly config: Config) {
		this.services = new ServerServices(config);
		this.app = createApp(
			this.services,
			this.services.tracker,
			this.services.logger,
			this.services.metrics,
		);
	}
	async start() {
		const service = this.services;
		try {
			await new MigrationService(service.database).run();
			await service.redis.connect();
			if (!(await service.database.ping()) || !(await service.redis.ping()))
				throw new Error("Dependencies unavailable");
			service.health.ready = true;
			this.app.listen({ hostname: this.config.host, port: this.config.port });
			const maintenance = new MaintenanceService(
				service.database,
				service.meters,
				service.settings,
			);
			this.cron = Bun.cron(
				"* * * * *",
				() => {
					this.maintenancePass = maintenance
						.runOnce()
						.catch(() => service.logger.write("error", "maintenance.failed"));
					return this.maintenancePass;
				},
				{ tz: "UTC" },
			);
			this.dispatchTimer = setInterval(() => {
				void this.dispatch();
			}, 1000);
			service.logger.write("info", "server.started");
		} catch (error) {
			await this.stop();
			throw error;
		}
	}
	private async dispatch() {
		if (this.dispatching || this.services.tracker.draining) return;
		this.dispatching = true;
		try {
			await this.services.dispatcher.runOnce();
		} catch {
			this.services.logger.write("error", "webhook.dispatch.failed");
		} finally {
			this.dispatching = false;
		}
	}
	stop() {
		this.closing ??= this.drain();
		return this.closing;
	}
	private async drain() {
		const service = this.services;
		service.health.ready = false;
		service.tracker.draining = true;
		this.cron?.stop();
		clearInterval(this.dispatchTimer);
		service.dispatcher.stop();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled([
					this.app.server?.stop(false),
					service.dispatcher.drain(),
					this.maintenancePass,
				]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 25000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			await this.app.server?.stop(true);
			service.redis.close();
			await service.database.close();
			service.logger.write("info", "server.stopped");
		}
	}
}
