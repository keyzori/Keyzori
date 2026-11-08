import { createApp } from "../app";
import { ServerServices } from "./ServerServices";
import { MigrationService } from "./database/MigrationService";
import { MaintenanceService } from "./MaintenanceService";
import { HttpError } from "./http/HttpError";
import { Logger } from "./observability/Logger";
import type { Config } from "./config/Config";

type BackgroundPass = {
	inFlight?: Promise<void>;
	nextAttemptAt: number;
	failures: number;
};

export class ServerLifecycle {
	readonly services;
	readonly app;
	private cron?: Bun.CronJob;
	private dispatchTimer?: ReturnType<typeof setInterval>;
	private readonly publication: BackgroundPass = {
		nextAttemptAt: 0,
		failures: 0,
	};
	private readonly delivery: BackgroundPass = { nextAttemptAt: 0, failures: 0 };
	private readonly observations: BackgroundPass = {
		nextAttemptAt: 0,
		failures: 0,
	};
	private maintenancePass: Promise<unknown> = Promise.resolve();
	private maintenanceRunning = false;
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
			service.health.setPhase("schema");
			await new MigrationService(service.database).verify();
			service.health.setPhase("dependencies");
			await service.redis.connect();
			if (!(await service.database.ping()) || !(await service.redis.ping()))
				throw new Error("Dependencies unavailable");
			if (service.tracker.draining) throw new Error("Startup interrupted");
			service.health.setPhase("publication");
			await service.activity.publish();
			if (service.tracker.draining) throw new Error("Startup interrupted");
			this.app.listen({ hostname: this.config.host, port: this.config.port });
			service.health.setPhase("serving");
			const maintenance = new MaintenanceService(
				service.database,
				service.meters,
				service.settings,
				service.logger,
				this.config.maintenance,
				service.metrics,
			);
			this.cron = Bun.cron(
				"* * * * *",
				() => {
					if (this.maintenanceRunning || service.tracker.draining)
						return this.maintenancePass;
					this.maintenanceRunning = true;
					this.maintenancePass = this.maintain(maintenance)
						.catch((error) =>
							service.logger.write("error", "maintenance.failed", {
								phase: "maintenance",
								cause: Logger.cause(error),
							}),
						)
						.finally(() => {
							this.maintenanceRunning = false;
						});
					return this.maintenancePass;
				},
				{ tz: "UTC" },
			);
			this.dispatchTimer = setInterval(() => {
				this.dispatch();
			}, 1000);
			service.logger.write("info", "server.started");
		} catch (error) {
			service.health.setPhase("failed", error);
			await this.stop();
			throw error;
		}
	}
	private async maintain(maintenance: MaintenanceService) {
		await maintenance.runOnce();
		if (
			this.config.eventRetentionDays === null ||
			this.services.tracker.draining
		)
			return;
		const deadlineAt = Date.now() + this.config.maintenance.cleanupTimeMs;
		let remaining = this.config.maintenance.cleanupRows;
		while (
			remaining > 0 &&
			Date.now() < deadlineAt &&
			!this.services.tracker.draining
		) {
			const result = await this.services.activity.prune({
				retentionMs: this.config.eventRetentionDays * 86400000,
				limit: Math.min(remaining, 1000),
				deadlineAt,
			});
			remaining -= result.removed;
			if (result.removed === 0) break;
		}
	}
	private dispatch() {
		if (this.services.tracker.draining) return;
		this.background("publication", this.publication, () =>
			this.services.activity.publish(),
		);
		this.background("delivery", this.delivery, () =>
			this.services.dispatcher.runOnce(),
		);
		this.background(
			"observability",
			this.observations,
			async () => {
				const backlog = await this.services.activity.backlog(Date.now() + 1000);
				this.services.metrics.setGauge(
					"keyzori_event_publication_backlog",
					backlog.unpublished,
				);
				this.services.metrics.setGauge(
					"keyzori_event_publication_lag_seconds",
					backlog.publicationLagSeconds,
				);
				this.services.metrics.setGauge(
					"keyzori_event_observed_at_seconds",
					Date.now() / 1000,
				);
			},
			10000,
		);
	}
	private background(
		phase: "publication" | "delivery" | "observability",
		state: BackgroundPass,
		work: () => Promise<unknown>,
		intervalMs = 0,
	) {
		if (state.inFlight || Date.now() < state.nextAttemptAt) return;
		state.inFlight = (async () => {
			try {
				await Promise.resolve().then(work);
				if (state.failures)
					this.services.logger.write("info", "background.recovered", { phase });
				state.failures = 0;
				state.nextAttemptAt = Date.now() + intervalMs;
			} catch (error) {
				state.failures = Math.min(state.failures + 1, 6);
				// Retry and diagnostics share a capped backoff, independently per job.
				state.nextAttemptAt =
					Date.now() + Math.min(1000 * 2 ** state.failures, 30000);
				this.services.logger.write("error", "background.failed", {
					phase,
					code: "BACKGROUND_RETRY_SCHEDULED",
					cause: error instanceof HttpError ? error.code : "UNEXPECTED_ERROR",
				});
			} finally {
				state.inFlight = undefined;
			}
		})();
	}
	stop() {
		this.closing ??= this.drain();
		return this.closing;
	}
	private async drain() {
		const service = this.services;
		service.health.setPhase("draining");
		service.tracker.draining = true;
		this.cron?.stop();
		clearInterval(this.dispatchTimer);
		service.dispatcher.stop();
		service.activity.stop();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let forced = false;
		try {
			await Promise.race([
				Promise.allSettled([
					this.app.server?.stop(false),
					service.dispatcher.drain(),
					this.publication.inFlight,
					this.delivery.inFlight,
					this.observations.inFlight,
					this.maintenancePass,
				]),
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						forced = true;
						service.logger.write("warn", "server.shutdown.deadline", {
							code: "DRAIN_DEADLINE_EXCEEDED",
						});
						resolve();
					}, 25000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			await this.app.server?.stop(true);
			service.redis.close();
			await service.database.close();
			service.logger.write("info", "server.stopped", {
				code: forced ? "FORCED_SHUTDOWN" : "DRAINED",
			});
		}
	}
}
