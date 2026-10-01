import { guard } from "../../../core/http/guard";
import type { $Requests } from "../../../types/application";
import type { Metrics } from "../../../core/observability/Metrics";

export const readMetrics = (metrics: Metrics, requests: $Requests) =>
	guard(requests, "root").get(
		"/metrics",
		{
			detail: {
				tags: ["Operations"],
				security: [{ bearerAuth: [] }],
				responses: {
					"200": {
						description: "Prometheus exposition",
						content: { "text/plain": { schema: { type: "string" } } },
					},
				},
			},
		},
		() =>
			new Response(metrics.text(), {
				headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
			}),
	);
