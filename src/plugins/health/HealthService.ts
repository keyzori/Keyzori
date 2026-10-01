import type { Database } from "../../core/database/Database";
import type { Redis } from "../../core/redis/Redis";
import type { RequestTracker } from "../../core/http/RequestTracker";
import type { Metrics } from "../../core/observability/Metrics";

export class HealthService {
	ready = false;
	constructor(
		private readonly database: Database,
		private readonly redis: Redis,
		private readonly tracker: RequestTracker,
		private readonly metrics: Metrics,
		readonly version: string,
	) {}
	async status() {
		const started = performance.now();
		const [postgresql, redis] = await Promise.all([
			this.database
				.ping()
				.catch(() => false)
				.then((success) => {
					this.metrics.dependency(
						"postgresql",
						success,
						(performance.now() - started) / 1000,
					);
					return success;
				}),
			this.redis
				.ping()
				.catch(() => false)
				.then((success) => {
					this.metrics.dependency(
						"redis",
						success,
						(performance.now() - started) / 1000,
					);
					return success;
				}),
		]);
		return {
			healthy: this.ready && !this.tracker.draining && postgresql && redis,
			postgresql,
			redis,
			version: this.version,
		};
	}
}
