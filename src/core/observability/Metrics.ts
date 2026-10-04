export class Metrics {
	private readonly counters = new Map<string, number>();
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
	private increment(key: string) {
		this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
	}
	text() {
		return `# TYPE keyzori_http_requests_total counter\n# TYPE keyzori_validation_total counter\n# TYPE keyzori_dependency_checks_total counter\n# TYPE keyzori_transaction_failures_total counter\n# TYPE keyzori_webhook_attempts_total counter\n${[...this.counters].map(([key, value]) => `${key} ${value}`).join("\n")}\n# TYPE keyzori_active_requests gauge\nkeyzori_active_requests ${this.active}\n# TYPE keyzori_http_duration_seconds summary\nkeyzori_http_duration_seconds_sum ${this.duration}\nkeyzori_http_duration_seconds_count ${this.requests}\n# TYPE keyzori_dependency_duration_seconds summary\n${[...this.dependencyDurations].map(([name, entry]) => `keyzori_dependency_duration_seconds_sum{dependency="${name}"} ${entry.sum}\nkeyzori_dependency_duration_seconds_count{dependency="${name}"} ${entry.count}`).join("\n")}\n`;
	}
}
