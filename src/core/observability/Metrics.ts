const operationalGauges = [
	"keyzori_streams_active",
	"keyzori_stream_queue_messages",
	"keyzori_stream_queue_bytes",
	"keyzori_event_publication_backlog",
	"keyzori_event_publication_lag_seconds",
	"keyzori_event_observed_at_seconds",
	"keyzori_webhook_pending",
	"keyzori_webhook_claimed",
	"keyzori_webhook_oldest_seconds",
	"keyzori_cleanup_resets_backlog",
	"keyzori_cleanup_resets_oldest_seconds",
	"keyzori_cleanup_receipts_backlog",
	"keyzori_cleanup_receipts_oldest_seconds",
	"keyzori_cleanup_webhooks_backlog",
	"keyzori_cleanup_webhooks_oldest_seconds",
	"keyzori_cleanup_backlog_sample_limit",
	"keyzori_cleanup_observed_at_seconds",
] as const;

export type OperationalGauge = (typeof operationalGauges)[number];
export type RetainedTable =
	| "events"
	| "audits"
	| "accepted_usage"
	| "receipts"
	| "webhook_deliveries"
	| "webhook_attempts";

export class Metrics {
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<OperationalGauge, number>(
		operationalGauges.map((name) => [name, 0]),
	);
	private readonly retained = new Map<
		RetainedTable,
		{ estimatedRows: number; bytes: number }
	>();
	private readonly dependencyDurations = new Map<
		string,
		{ sum: number; count: number }
	>();
	private active = 0;
	private duration = 0;
	private requests = 0;
	start() {
		this.active++;
	}
	finish(method: string, route: string, status: number, seconds: number) {
		this.active = Math.max(0, this.active - 1);
		this.requests++;
		this.duration += seconds;
		this.increment(
			`keyzori_http_requests_total{method=${JSON.stringify(method)},route=${JSON.stringify(route)},status="${status}"}`,
		);
	}
	validation(code: string) {
		this.increment(`keyzori_validation_total{code=${JSON.stringify(code)}}`);
	}
	dependency(name: "postgresql" | "redis", success: boolean, seconds = 0) {
		const previous = this.dependencyDurations.get(name) ?? { sum: 0, count: 0 };
		this.dependencyDurations.set(name, {
			sum: previous.sum + seconds,
			count: previous.count + 1,
		});
		this.increment(
			`keyzori_dependency_checks_total{dependency="${name}",outcome="${success ? "success" : "failure"}"}`,
		);
	}
	transactionFailure() {
		this.increment("keyzori_transaction_failures_total");
	}
	webhook(outcome: "succeeded" | "failed" | "claimed") {
		this.increment(`keyzori_webhook_attempts_total{outcome="${outcome}"}`);
	}
	/** Process-local aggregates only; never resource, endpoint, principal or cursor labels. */
	setGauge(name: OperationalGauge, value: number) {
		if (!this.gauges.has(name) || !Number.isFinite(value) || value < 0)
			throw new Error("Invalid operational metric");
		this.gauges.set(name, value);
	}
	maintenance(
		kind: "resets" | "receipts" | "webhooks",
		outcome: "succeeded" | "failed" | "deferred",
		count = 1,
	) {
		if (!Number.isSafeInteger(count) || count < 0)
			throw new Error("Invalid maintenance metric");
		const key = `keyzori_maintenance_rows_total{kind="${kind}",outcome="${outcome}"}`;
		this.counters.set(key, (this.counters.get(key) ?? 0) + count);
	}
	/** Rows are PostgreSQL catalogue estimates; bytes include indexes and TOAST. */
	retention(table: RetainedTable, estimatedRows: number, bytes: number) {
		if (
			![
				"events",
				"audits",
				"accepted_usage",
				"receipts",
				"webhook_deliveries",
				"webhook_attempts",
			].includes(table) ||
			!Number.isFinite(estimatedRows) ||
			!Number.isFinite(bytes) ||
			estimatedRows < 0 ||
			bytes < 0
		)
			throw new Error("Invalid retention metric");
		this.retained.set(table, { estimatedRows, bytes });
	}
	private increment(key: string) {
		this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
	}
	text() {
		return `${[
			...[
				"http_requests",
				"validation",
				"dependency_checks",
				"transaction_failures",
				"webhook_attempts",
				"maintenance_rows",
			].map((name) => `# TYPE keyzori_${name}_total counter`),
			...[...this.counters].map(([key, value]) => `${key} ${value}`),
			"# TYPE keyzori_active_requests gauge",
			`keyzori_active_requests ${this.active}`,
			"# TYPE keyzori_http_duration_seconds summary",
			`keyzori_http_duration_seconds_sum ${this.duration}`,
			`keyzori_http_duration_seconds_count ${this.requests}`,
			"# TYPE keyzori_dependency_duration_seconds summary",
			...[...this.dependencyDurations].flatMap(([name, entry]) => [
				`keyzori_dependency_duration_seconds_sum{dependency="${name}"} ${entry.sum}`,
				`keyzori_dependency_duration_seconds_count{dependency="${name}"} ${entry.count}`,
			]),
			"# HELP keyzori_cleanup_backlog_sample_limit Backlog counts at this limit are lower bounds; oldest age includes deferred work.",
			"# HELP keyzori_cleanup_observed_at_seconds Last completed cleanup observation, or zero before the first sample.",
			...[...this.gauges].flatMap(([name, value]) => [
				`# TYPE ${name} gauge`,
				`${name} ${value}`,
			]),
			"# HELP keyzori_retained_rows_estimate PostgreSQL catalogue row estimate, updated by ANALYZE.",
			"# TYPE keyzori_retained_rows_estimate gauge",
			"# HELP keyzori_retained_bytes Retained table, index and TOAST bytes.",
			"# TYPE keyzori_retained_bytes gauge",
			...[...this.retained].flatMap(([table, value]) => [
				`keyzori_retained_rows_estimate{table="${table}"} ${value.estimatedRows}`,
				`keyzori_retained_bytes{table="${table}"} ${value.bytes}`,
			]),
		].join("\n")}\n`;
	}
}
