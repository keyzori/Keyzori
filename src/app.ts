import { Elysia } from "elysia";
import { cors } from "@elysia/cors";
import { HttpBoundary } from "./core/http/HttpBoundary";
import { ValidateCors } from "./core/http/ValidateCors";
import { apiKeyRoutes } from "./plugins/api-keys/index";
import { healthRoutes } from "./plugins/health/index";
import { itemRoutes } from "./plugins/items/index";
import { licenseRoutes } from "./plugins/licenses/index";
import { metricsRoutes } from "./plugins/metrics/index";
import { settingsRoutes } from "./plugins/settings/index";
import { userRoutes } from "./plugins/users/index";
import { validationRoutes } from "./plugins/validate/index";
import { webhookRoutes } from "./plugins/webhooks/index";
import type { RequestTracker } from "./core/http/RequestTracker";
import type { Logger } from "./core/observability/Logger";
import type { Metrics } from "./core/observability/Metrics";
import type { $ApplicationServices } from "./types/application";

export const createApp = (
	services: $ApplicationServices,
	tracker: RequestTracker,
	logger: Logger,
	metrics: Metrics,
) => {
	const boundary = new HttpBoundary(tracker, logger);
	const origins = new ValidateCors(services.settings);
	const paths = new Set<string>();
	const app = new Elysia({
		name: "keyzori",
		normalize: false,
		serve: { maxRequestBodySize: Number.MAX_SAFE_INTEGER, idleTimeout: 15 },
	})
		.headers({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		})
		.request(async ({ request, set }) => {
			const context = tracker.begin(request);
			set.headers["X-Request-Id"] = context.requestId;
			boundary.start(request);
			await origins.prepare(request, context.deadlineAt);
		})
		.use(
			cors({
				origin: (request) => origins.allows(request),
				credentials: false,
				preflight: false,
				methods: ["POST", "OPTIONS"],
				allowedHeaders: ["Content-Type", "Idempotency-Key"],
				exposeHeaders: ["X-Request-Id"],
				maxAge: 0,
			}),
		)
		.parse(({ request }) => boundary.parse(request))
		.error(({ error, request, set }) => {
			const response = boundary.error(error, request);
			set.headers["X-Request-Id"] = tracker.begin(request).requestId;
			set.status = response.status;
			return response;
		})
		.afterResponse(({ request, set }) => {
			const path = new URL(request.url).pathname;
			tracker.finish(
				request,
				paths.has(path) ? path : "unmatched",
				typeof set.status === "number" ? set.status : 200,
			);
		})
		.use(healthRoutes(services.health))
		.use(validationRoutes(services.validation, services.requests, metrics))
		.use(licenseRoutes(services.licenses, services.requests))
		.use(userRoutes(services.users, services.requests))
		.use(itemRoutes(services.items, services.requests))
		.use(apiKeyRoutes(services.apiKeys, services.requests))
		.use(settingsRoutes(services.settings, services.requests))
		.use(webhookRoutes(services.webhooks, services.requests))
		.use(metricsRoutes(metrics, services.requests));
	for (const route of app.routes) paths.add(route.path);
	return app;
};
