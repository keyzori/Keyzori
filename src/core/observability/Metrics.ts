const operationalGauges = [
	"keyzori_streams_active",
	"keyzori_stream_queue_messages",
	"keyzori_stream_queue_bytes",
	"keyzori_stream_transport_buffered_bytes",
	"keyzori_stream_transport_sample_available",
	"keyzori_stream_transport_observed_at_seconds",
	"keyzori_event_publication_backlog",
	"keyzori_event_publication_lag_seconds",
	"keyzori_event_observed_at_seconds",
	"keyzori_webhook_pending",
	"keyzori_webhook_claimed",
	"keyzori_webhook_oldest_seconds",
	"keyzori_webhook_observed_at_seconds",
	"keyzori_webhook_backlog_sample_limit",
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
const knownGauges = new Set(operationalGauges);
const unsampledGauges = new Set<OperationalGauge>([
	"keyzori_stream_transport_buffered_bytes",
	"keyzori_webhook_pending",
	"keyzori_webhook_claimed",
	"keyzori_webhook_oldest_seconds",
]);
type WebhookQueue = { pending: number; claimed: number; oldestSeconds: number };
const admissionReasons = [
	"draining",
	"capacity",
	"peer_missing",
	"rate_limited",
	"limiter_unavailable",
] as const;
export type AdmissionFailure = (typeof admissionReasons)[number];
export type RetainedTable =
	| "events"
	| "audits"
	| "accepted_usage"
	| "receipts"
	| "webhook_deliveries"
	| "webhook_attempts";

export class Metrics {
	private readonly counters = new Map<string, number>([
		["keyzori_stream_backpressure_closes_total", 0],
		["keyzori_transaction_failures_total", 0],
		...admissionReasons.map(
			(reason) =>
				[`keyzori_admission_rejections_total{reason="${reason}"}`, 0] as const,
		),
		...["postgresql", "redis"].flatMap((name) =>
			["failure", "success"].map(
				(outcome) =>
					[
						`keyzori_dependency_checks_total{dependency="${name}",outcome="${outcome}"}`,
						0,
					] as const,
			),
		),
	]);
	private readonly gauges = new Map<OperationalGauge, number>(
		operationalGauges
			.filter((name) => !unsampledGauges.has(name))
			.map((name) => [name, 0]),
	);
	private lastWebhookQueue?: WebhookQueue & {
		sampleLimit: number;
		observedAt: string;
		completedAt: number;
	};
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
	transactionRollback(kind: "expected" | "conflict" | "replay" = "expected") {
		this.increment(`keyzori_transaction_rollbacks_total{kind="${kind}"}`);
	}
	streamBackpressureClose() {
		this.increment("keyzori_stream_backpressure_closes_total");
	}
	/** Absence is not zero. Preserve last-success time, but remove an obsolete byte reading. */
	streamTransportSample(bytes: number | undefined) {
		if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
			this.gauges.delete("keyzori_stream_transport_buffered_bytes");
			this.setGauge("keyzori_stream_transport_sample_available", 0);
			return;
		}
		this.setGauge("keyzori_stream_transport_buffered_bytes", bytes);
		this.setGauge("keyzori_stream_transport_sample_available", 1);
		this.setGauge(
			"keyzori_stream_transport_observed_at_seconds",
			Date.now() / 1000,
		);
	}
	admissionFailure(reason: AdmissionFailure) {
		this.increment(`keyzori_admission_rejections_total{reason="${reason}"}`);
	}
	webhookQueue(sample: WebhookQueue, sampleLimit: number) {
		if (
			!Number.isSafeInteger(sampleLimit) ||
			sampleLimit < 1 ||
			![sample.pending, sample.claimed].every(
				(n) => Number.isSafeInteger(n) && n >= 0 && n <= sampleLimit,
			) ||
			!Number.isFinite(sample.oldestSeconds) ||
			sample.oldestSeconds < 0
		)
			throw new Error("Invalid webhook queue observation");
		const now = new Date();
		this.lastWebhookQueue = {
			...sample,
			sampleLimit,
			observedAt: now.toISOString(),
			completedAt: performance.now(),
		};
		this.setGauge("keyzori_webhook_pending", sample.pending);
		this.setGauge("keyzori_webhook_claimed", sample.claimed);
		this.setGauge("keyzori_webhook_oldest_seconds", sample.oldestSeconds);
		this.setGauge("keyzori_webhook_backlog_sample_limit", sampleLimit);
		this.setGauge("keyzori_webhook_observed_at_seconds", now.getTime() / 1000);
	}
	webhookDiagnostics() {
		if (!this.lastWebhookQueue) return null;
		const { completedAt, ...sample } = this.lastWebhookQueue;
		return {
			...sample,
			ageMs: Math.max(0, Math.floor(performance.now() - completedAt)),
		};
	}
	webhook(outcome: "succeeded" | "failed" | "claimed") {
		this.increment(`keyzori_webhook_attempts_total{outcome="${outcome}"}`);
	}
	/** Process-local aggregates only; never resource, endpoint, principal or cursor labels. */
	setGauge(name: OperationalGauge, value: number) {
		if (!knownGauges.has(name) || !Number.isFinite(value) || value < 0)
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
			"# HELP keyzori_stream_backpressure_closes_total Streams closed by this process due to backpressure.",
			"# HELP keyzori_dependency_checks_total Completed dependency probes. Cache hits and coalesced callers are not additional checks.",
			...[
				"http_requests",
				"validation",
				"dependency_checks",
				"transaction_failures",
				"transaction_rollbacks",
				"stream_backpressure_closes",
				"admission_rejections",
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
			"# HELP keyzori_stream_transport_buffered_bytes Sampled native buffered bytes across all local streams; omitted if any socket cannot be measured or observation fails.",
			"# HELP keyzori_stream_transport_sample_available Whether the latest observation measured native buffered bytes for every local stream.",
			"# HELP keyzori_stream_transport_observed_at_seconds Last successful native buffered-byte measurement, or zero before first success.",
			"# HELP keyzori_webhook_backlog_sample_limit Maximum rows sampled per state; counts at the limit and sampled oldest age are lower bounds.",
			"# HELP keyzori_webhook_observed_at_seconds Last successful webhook queue observation, or zero before first success.",
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
