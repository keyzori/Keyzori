import type { AppLogger } from "../../src/shared/logging.ts";
import type { StripeRepository } from "./StripeRepository.ts";
import type { StripeService } from "./StripeService.ts";

export class StripeWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private pending: Promise<void> | undefined;
	constructor(
		private readonly repository: StripeRepository,
		private readonly service: StripeService,
		private readonly logger: AppLogger,
	) {}
	start() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 1000);
	}
	tick() {
		if (this.pending) return this.pending;
		this.pending = this.process()
			.catch(() => this.logger.error("stripe.worker_unavailable"))
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}
	private async process() {
		const event = await this.repository.claim();
		if (!event) return;
		try {
			await this.service.process(event);
		} catch {
			await this.repository.retry(event);
			this.logger.error("stripe.event_retry_scheduled");
		}
	}
	async stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.pending;
	}
}
