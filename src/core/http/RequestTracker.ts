import type { Metrics } from "../observability/Metrics";
import type { $TrackedRequest } from "../../types/http";
import { operationFor } from "./operations";

export class RequestTracker {
	private readonly requests = new WeakMap<
		Request,
		{ context: $TrackedRequest; clock: number; finished: boolean }
	>();
	draining = false;
	active = 0;
	constructor(private readonly metrics?: Metrics) {}
	/** The outer fetch owns admission, including upgrades and Elysia's abort returns. */
	wrap<Args extends unknown[]>(
		next: (request: Request, ...args: Args) => Response | Promise<Response>,
	) {
		return async (request: Request, ...args: Args) => {
			if (this.requests.get(request)?.finished) this.requests.delete(request);
			this.begin(request);
			let status = 500;
			try {
				const response = await next(request, ...args);
				// Bun's successful server.upgrade returns no HTTP Response.
				status =
					response?.status ??
					(request.headers.get("upgrade")?.toLowerCase() === "websocket"
						? 101
						: 500);
				return response;
			} finally {
				// A disconnect is not the end of in-flight work. Settle only after
				// the actual handler has returned, including on a rejected upgrade.
				const route = operationFor(
					request.method,
					new URL(request.url).pathname,
				);
				this.finish(
					request,
					route?.path ?? "unmatched",
					status !== 101 && request.signal.aborted ? 499 : status,
				);
			}
		};
	}
	begin(request: Request) {
		const existing = this.requests.get(request);
		if (existing) return existing.context;
		const startedAt = Date.now();
		const entry: $TrackedRequest = {
			requestId: Bun.randomUUIDv7(),
			startedAt,
			deadlineAt: startedAt + 15000,
		};
		this.requests.set(request, {
			context: entry,
			clock: performance.now(),
			finished: false,
		});
		this.active++;
		this.metrics?.start();
		return entry;
	}
	finish(request: Request, route: string, status: number) {
		const entry = this.requests.get(request);
		if (!entry || entry.finished) return;
		// Late lifecycle hooks may still ask for this request's correlation ID.
		// Keep the identity weakly held without reacquiring its admission slot.
		entry.finished = true;
		this.active--;
		const method = [
			"GET",
			"HEAD",
			"POST",
			"PATCH",
			"DELETE",
			"OPTIONS",
		].includes(request.method)
			? request.method
			: "OTHER";
		this.metrics?.finish(
			method,
			route,
			status,
			(performance.now() - entry.clock) / 1000,
		);
	}
}
