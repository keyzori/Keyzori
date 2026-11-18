import { createApp } from "../app";
import { ServerServices } from "./ServerServices";
import { MigrationService } from "./database/MigrationService";
import { MaintenanceService } from "./MaintenanceService";
import { HttpError } from "./http/HttpError";
import { Logger } from "./observability/Logger";
import { observeActivity } from "./observability/observeActivity";
import type { Config } from "./config/Config";

type BackgroundPass = {
	inFlight?: Promise<void>;
	nextAttemptAt: number;
	failures: number;
};

class StartupInterrupted extends Error {
	constructor() {
		super("Startup interrupted");
	}
}

export class ShutdownError extends Error {
	constructor(
		readonly code: "FORCED_SHUTDOWN" | "SHUTDOWN_FAILED",
		cause?: unknown,
	) {
		super(code, { cause });
		this.name = "ShutdownError";
	}
}

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
	private readonly webhookObservations: BackgroundPass = {
		nextAttemptAt: 0,
		failures: 0,
	};
	private maintenancePass?: Promise<void>;
	private closing?: Promise<void>;
	private boot?: Promise<void>;
	private started?: Promise<void>;
	private startupFailedBeforeStop = false;
	startupPhase:
		| "configuration"
		| "schema"
		| "dependencies"
		| "publication"
		| "listen"
		| "scheduler" = "configuration";
	constructor(
		private readonly config: Config,
		private readonly shutdownBudget = { graceMs: 25000, totalMs: 29000 },
	) {
		if (
			!Number.isSafeInteger(shutdownBudget.graceMs) ||
			!Number.isSafeInteger(shutdownBudget.totalMs) ||
			shutdownBudget.graceMs < 1 ||
			shutdownBudget.totalMs <= shutdownBudget.graceMs ||
			shutdownBudget.totalMs > 29000
		)
			throw new Error("Invalid shutdown budgets");
		this.services = new ServerServices(config);
		this.app = createApp(
			this.services,
			this.services.tracker,
			this.services.logger,
			this.services.metrics,
		);
	}
	start() {
		if (this.closing) return Promise.reject(new StartupInterrupted());
		if (this.started) return this.started;
		// Drain joins the raw bootstrap. The public failure handler can therefore
		// await cleanup without ever waiting for its own promise.
		this.boot = Promise.resolve().then(() => this.bootstrap());
		this.started = this.boot.catch(async (error: unknown) => {
			if (!this.closing) {
				this.startupFailedBeforeStop = true;
				this.services.health.setPhase("failed", error);
			}
			await this.stop().catch(() => {}); // drain reports cleanup failures independently
			throw error;
		});
		return this.started;
	}
	private fence() {
		if (this.services.tracker.draining) throw new StartupInterrupted();
	}
	private async bootstrap() {
		const service = this.services;
		this.fence();
		this.startupPhase = "schema";
		service.health.setPhase("schema");
		await new MigrationService(service.database).verifyRuntime();
		this.fence();
		this.startupPhase = "dependencies";
		service.health.setPhase("dependencies");
		await service.redis.connect();
		this.fence();
		if (!(await service.database.ping()))
			throw new HttpError("SERVICE_UNAVAILABLE");
		this.fence();
		if (!(await service.redis.ping()))
			throw new HttpError("SERVICE_UNAVAILABLE");
		this.fence();
		this.startupPhase = "publication";
		service.health.setPhase("publication");
		await service.activity.publish();
		this.fence();
		this.startupPhase = "listen";
		this.app.listen({ hostname: this.config.host, port: this.config.port });
		this.startupPhase = "scheduler";
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
				if (this.maintenancePass || service.tracker.draining) return;
				this.maintenancePass = this.maintain(maintenance).finally(() => {
					this.maintenancePass = undefined;
				});
				return this.maintenancePass.catch((error) =>
					service.logger.write("error", "maintenance.failed", {
						phase: "maintenance",
						cause: Logger.cause(error),
					}),
				);
			},
			{ tz: "UTC" },
		);
		this.dispatchTimer = setInterval(() => {
			this.dispatch();
		}, 1000);
		service.health.setPhase("serving");
		service.logger.write("info", "server.started");
	}
	private async maintain(maintenance: Pick<MaintenanceService, "runOnce">) {
		if (this.services.tracker.draining) return;
		const days = this.config.eventRetentionDays;
		await maintenance.runOnce(
			days === null
				? undefined
				: async (limit, deadlineAt) => {
						if (this.services.tracker.draining || Date.now() >= deadlineAt)
							return 0;
						const { removed } = await this.services.activity.prune({
							retentionMs: days * 86400000,
							limit: Math.min(limit, 1000),
							deadlineAt,
						});
						return removed;
					},
		);
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
			() =>
				observeActivity(
					this.services.activity,
					this.services.metrics,
					Date.now() + 1000,
				),
			10000,
		);
		this.background(
			"webhook_observation",
			this.webhookObservations,
			() => this.services.webhookQueue.observe(Date.now() + 1000),
			10000,
		);
	}
	private background(
		phase: "publication" | "delivery" | "observability" | "webhook_observation",
		state: BackgroundPass,
		work: () => Promise<unknown>,
		intervalMs = 0,
	) {
		if (state.inFlight || performance.now() < state.nextAttemptAt) return;
		state.inFlight = (async () => {
			try {
				await Promise.resolve();
				if (this.services.tracker.draining) return;
				await work();
				if (state.failures)
					this.services.logger.write("info", "background.recovered", { phase });
				state.failures = 0;
				state.nextAttemptAt = performance.now() + intervalMs;
			} catch (error) {
				state.failures = Math.min(state.failures + 1, 6);
				// Retry and diagnostics share a capped backoff, independently per job.
				state.nextAttemptAt =
					performance.now() + Math.min(1000 * 2 ** state.failures, 30000);
				this.services.logger.write("error", "background.failed", {
					phase,
					code: "BACKGROUND_RETRY_SCHEDULED",
					cause: Logger.cause(error),
				});
				throw error;
			} finally {
				state.inFlight = undefined;
			}
		})();
		// The scheduler logs and retries, but a drain joining this pass must see its failure.
		void state.inFlight.catch(() => {});
	}
	stop() {
		if (!this.closing) {
			const started = performance.now();
			this.services.tracker.draining = true;
			this.services.health.setPhase("draining");
			this.closing = Promise.resolve().then(() => this.drain(started));
		}
		return this.closing;
	}
	private async drain(started: number) {
		const service = this.services;
		const failures: unknown[] = [];
		const attempt = async (phase: string, work: () => unknown) => {
			try {
				await work();
			} catch (error) {
				failures.push(error);
				service.logger.write("error", "server.shutdown.failed", {
					phase,
					cause: Logger.cause(error),
				});
			}
		};
		clearInterval(this.dispatchTimer);
		const graceUntil = started + this.shutdownBudget.graceMs;
		const graceful = Promise.all([
			attempt("scheduler", () => this.cron?.stop()),
			attempt("delivery_stop", () => service.dispatcher.stop()),
			attempt("stream_stop", () => service.activity.stop()),
			attempt("listener", () => this.app.server?.stop(false)),
			attempt("requests", () => this.drainRequests(graceUntil)),
			attempt("startup", () =>
				this.boot?.catch((error: unknown) => {
					// A signal during a genuine startup failure must not turn it into a
					// clean exit. An already reported primary failure or our own fence is expected.
					if (
						!this.startupFailedBeforeStop &&
						!(error instanceof StartupInterrupted)
					)
						throw error;
				}),
			),
			attempt("streams", () => service.activity.drain()),
			attempt("delivery", () => service.dispatcher.drain()),
			attempt("publication", () => this.publication.inFlight),
			attempt("dispatch", () => this.delivery.inFlight),
			attempt("observation", () => this.observations.inFlight),
			attempt("webhook_observation", () => this.webhookObservations.inFlight),
			attempt("maintenance", () => this.maintenancePass),
		]);
		const drained = await this.until(graceful, graceUntil);
		if (!drained)
			service.logger.write("error", "server.shutdown.deadline", {
				code: "DRAIN_DEADLINE_EXCEEDED",
			});
		// Attempt every final closer even if another throws synchronously or stalls.
		const closed = await this.until(
			Promise.all([
				attempt("listener_close", () => this.app.server?.stop(true)),
				attempt("redis_close", () => service.redis.close()),
				attempt("postgresql_close", () => service.database.close()),
			]),
			started + this.shutdownBudget.totalMs,
		);
		const code = failures.length
			? "SHUTDOWN_FAILED"
			: !drained || !closed
				? "FORCED_SHUTDOWN"
				: "DRAINED";
		service.logger.write(
			code === "DRAINED" ? "info" : "error",
			"server.stopped",
			{ code },
		);
		if (code !== "DRAINED") throw new ShutdownError(code, failures[0]);
	}
	private async drainRequests(deadline: number) {
		// Native stop(false) can resolve on disconnect while its JS handler
		// still owns a transaction. Sample only during shutdown, for the
		// same finite grace period as the native listener and workers.
		while (this.services.tracker.active > 0) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) return;
			await Bun.sleep(Math.min(20, Math.ceil(remaining)));
		}
	}
	private async until(work: Promise<unknown>, deadline: number) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) return false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work.then(() => performance.now() <= deadline),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), Math.ceil(remaining));
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
