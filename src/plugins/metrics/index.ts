import { Elysia } from "elysia";
import type { $Requests } from "../../types/application";
import { readMetrics } from "./routes/read";
import type { Metrics } from "../../core/observability/Metrics";

export const metricsRoutes = (metrics: Metrics, requests: $Requests) =>
	new Elysia({ normalize: false }).use(readMetrics(metrics, requests));
