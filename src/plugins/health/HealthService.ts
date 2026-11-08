import type { Database } from "../../core/database/Database";
import type { Redis } from "../../core/redis/Redis";
import type { RequestTracker } from "../../core/http/RequestTracker";
import type { Metrics } from "../../core/observability/Metrics";
import { Logger } from "../../core/observability/Logger";

export type HealthPhase =
	| "configuration"
	| "schema"
	| "dependencies"
	| "publication"
	| "serving"
	| "draining"
	| "failed";
type DependencyCheck = {
	healthy: boolean;
	cause: string | null;
	durationMs: number;
};
type Probe = {
	postgresql: DependencyCheck;
	redis: DependencyCheck;
	checkedAt: string;
};

export class HealthService {
	ready = false;
	private phase: HealthPhase = "configuration";
	private cause: string | null = null;
	private pending?: Promise<Probe>;
	private cached?: Probe;
	private completedAt = -Infinity;
	constructor(
		private readonly database: Pick<Database, "ping">,
		private readonly redis: Pick<Redis, "ping">,
		private readonly tracker: Pick<RequestTracker, "draining" | "active">,
		private readonly metrics: Metrics,
		readonly version: string,
		private readonly options = { cacheMs: 1000, timeoutMs: 4500 },
	) {
		if (
			!Number.isSafeInteger(options.cacheMs) ||
			options.cacheMs < 0 ||
			options.cacheMs > 10000 ||
			!Number.isSafeInteger(options.timeoutMs) ||
			options.timeoutMs < 1 ||
			options.timeoutMs > 10000
		)
			throw new Error("Invalid health probe budget");
	}

	setPhase(phase: HealthPhase, error?: unknown) {
		this.phase = phase;
		this.ready = phase === "serving";
		this.cause = error === undefined ? null : Logger.cause(error);
	}

	/** Public readiness contains dependency booleans, never failure details. */
	async status() {
		return this.readiness(await this.probe());
	}

	/** Exposed only through the master-authorized diagnostics route. */
	async diagnostics() {
		const probe = await this.probe();
		return {
			...this.readiness(probe),
			phase: this.tracker.draining
				? ("draining" as const)
				: this.ready
					? ("serving" as const)
					: this.phase,
			draining: this.tracker.draining,
			activeRequests: this.tracker.active,
			cause: this.cause,
			checks: {
				postgresql: { ...probe.postgresql },
				redis: { ...probe.redis },
			},
		};
	}

	private readiness(probe: Probe) {
		return {
			postgresql: probe.postgresql.healthy,
			redis: probe.redis.healthy,
			checkedAt: probe.checkedAt,
			healthy:
				this.ready &&
				!this.tracker.draining &&
				probe.postgresql.healthy &&
				probe.redis.healthy,
			ageMs: Math.max(0, Date.now() - Date.parse(probe.checkedAt)),
			version: this.version,
		};
	}

	private probe(): Promise<Probe> {
		if (this.pending) return this.pending;
		if (
			this.cached &&
			performance.now() - this.completedAt < this.options.cacheMs
		)
			return Promise.resolve(this.cached);
		this.pending = this.check()
			.then((probe) => {
				this.cached = probe;
				this.completedAt = performance.now();
				return probe;
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	private async check() {
		const [postgresql, redis] = await Promise.all([
			this.dependency("postgresql", (deadline) => this.database.ping(deadline)),
			this.dependency("redis", (deadline) => this.redis.ping(deadline)),
		]);
		return { postgresql, redis, checkedAt: new Date().toISOString() };
	}

	private async dependency(
		name: "postgresql" | "redis",
		ping: (deadline: number) => Promise<boolean>,
	): Promise<DependencyCheck> {
		const started = performance.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let healthy = false;
		let cause: string | null = null;
		try {
			const deadline = Date.now() + this.options.timeoutMs;
			healthy = await Promise.race([
				Promise.resolve().then(() => ping(deadline)),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new DOMException("Health probe expired", "TimeoutError")),
						this.options.timeoutMs,
					);
				}),
			]);
			if (!healthy) cause = "DEPENDENCY_UNAVAILABLE";
		} catch (error) {
			cause = Logger.cause(error);
		} finally {
			clearTimeout(timer);
		}
		const durationMs = Math.max(0, Math.round(performance.now() - started));
		this.metrics.dependency(name, healthy, durationMs / 1000);
		return { healthy, cause, durationMs };
	}
}
