import type { Metrics } from "../observability/Metrics";
import type { $TrackedRequest } from "../../types/http";

export class RequestTracker {
	private readonly requests = new WeakMap<Request, $TrackedRequest>();
	draining = false;
	constructor(private readonly metrics?: Metrics) {}
	begin(request: Request) {
		const existing = this.requests.get(request);
		if (existing) return existing;
		const entry: $TrackedRequest = {
			requestId: Bun.randomUUIDv7(),
			startedAt: Date.now(),
			deadlineAt: Date.now() + 15000,
		};
		this.requests.set(request, entry);
		this.metrics?.start();
		return entry;
	}
	finish(request: Request, route: string, status: number) {
		const entry = this.requests.get(request);
		if (!entry) return;
		this.requests.delete(request);
		const method = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"].includes(
			request.method,
		)
			? request.method
			: "OTHER";
		this.metrics?.finish(
			method,
			route,
			status,
			(Date.now() - entry.startedAt) / 1000,
		);
	}
}
