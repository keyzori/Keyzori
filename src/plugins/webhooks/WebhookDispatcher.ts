import type { Metrics } from "../../core/observability/Metrics";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../../core/database/Database";
import { deliveries } from "../../core/database/schema/deliveries";
import { webhooks } from "../../core/database/schema/webhooks";
import type { $WebhookClaim } from "../../types/webhookManagement";
import type { SettingsService } from "../settings/SettingsService";

/** Claims commit before sending; disabling only cancels work that remains pending. */
export class WebhookDispatcher {
	private stopped = false;
	private readonly running = new Set<Promise<void>>();
	constructor(
		private readonly database: Database,
		private readonly settings: SettingsService,
		private readonly metrics?: Metrics,
	) {}

	runOnce(limit = 10): Promise<void> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError("Webhook batch limit must be between 1 and 100");
		if (this.stopped) return Promise.resolve();
		const pass = this.dispatch(limit);
		this.running.add(pass);
		void pass.then(
			() => this.running.delete(pass),
			() => this.running.delete(pass),
		);
		return pass;
	}

	stop() {
		this.stopped = true;
	}
	async drain() {
		await Promise.allSettled(this.running);
	}

	private async dispatch(limit: number) {
		const attempts = await this.database.transaction(async (tx) => {
			if (this.stopped) return [];
			const settings = await this.settings.read(tx);
			const rows = await tx
				.select({
					delivery: deliveries,
					url: webhooks.url,
					enabled: webhooks.enabled,
				})
				.from(deliveries)
				.leftJoin(webhooks, eq(webhooks.id, deliveries.webhookId))
				.where(eq(deliveries.state, "pending"))
				.orderBy(asc(deliveries.createdAt), asc(deliveries.id))
				.limit(limit)
				.for("update", { of: deliveries, skipLocked: true });
			const claimed: $WebhookClaim[] = [];
			for (const row of rows) {
				if (!row.enabled || !row.url) {
					await tx
						.update(deliveries)
						.set({ state: "cancelled" })
						.where(eq(deliveries.id, row.delivery.id));
					continue;
				}
				if (this.stopped) break;
				await tx
					.update(deliveries)
					.set({ state: "claimed", attemptedAt: sql`clock_timestamp()` })
					.where(eq(deliveries.id, row.delivery.id));
				claimed.push({
					id: row.delivery.id,
					payload: row.delivery.payload,
					url: row.url,
					timeoutMs: settings.webhookTimeoutSeconds * 1000,
				});
			}
			return claimed;
		});
		for (const _attempt of attempts) this.metrics?.webhook("claimed");
		const results = await Promise.allSettled(
			attempts.map((attempt) => this.send(attempt)),
		);
		for (const result of results)
			if (result.status === "rejected") throw result.reason;
	}

	private async send(attempt: $WebhookClaim) {
		const signal = AbortSignal.timeout(attempt.timeoutMs);
		let status: number | null = null;
		let error: string | null = null;
		try {
			const response = await fetch(attempt.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(attempt.payload),
				redirect: "manual",
				signal,
			});
			status = response.status;
			await response.body?.cancel().catch(() => {});
		} catch (caught) {
			const code =
				caught && typeof caught === "object" && "code" in caught
					? caught.code
					: null;
			error = signal.aborted
				? "timeout"
				: code === "ENOTFOUND" ||
						code === "EAI_AGAIN" ||
						code === "DNSException"
					? "dns"
					: code === "ConnectionRefused" ||
							code === "ECONNREFUSED" ||
							code === "ECONNRESET" ||
							code === "ENETUNREACH" ||
							code === "EHOSTUNREACH"
						? "connection"
						: "transport";
		}
		this.metrics?.webhook(
			status !== null && status >= 200 && status < 300 ? "succeeded" : "failed",
		);
		await this.database.transaction(async (tx) => {
			await tx
				.update(deliveries)
				.set({
					state:
						status !== null && status >= 200 && status < 300
							? "succeeded"
							: "failed",
					status,
					error,
				})
				.where(
					and(eq(deliveries.id, attempt.id), eq(deliveries.state, "claimed")),
				);
		});
	}
}
