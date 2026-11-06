import { Elysia } from "elysia";
import { cors } from "@elysia/cors";
import { HttpBoundary } from "./core/http/HttpBoundary";
import { ValidateCors } from "./core/http/ValidateCors";
import { apiKeyRoutes } from "./plugins/api-keys/index";
import { healthRoutes } from "./plugins/health/index";
import { groupRoutes } from "./plugins/groups/index";
import { activityRoutes } from "./plugins/activity/index";
import { responseValidator, success } from "./core/http/Response";
import { assertOperations, operationFor } from "./core/http/operations";
import { HttpError } from "./core/http/HttpError";
import { licenseRoutes } from "./plugins/licenses/index";
import { usageHistoryRoutes } from "./plugins/licenses/routes/usage-history";
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
	const responseChecks = new Map<
		string,
		ReturnType<typeof responseValidator>
	>();
	const app = new Elysia({
		name: "keyzori",
		normalize: false,
		// The streaming boundary enforces 1 MiB. Leave room for its structured 413.
		serve: { maxRequestBodySize: 16777216, idleTimeout: 15 },
	})
		.headers({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		})
		.request(async ({ request, set, server }) => {
			const context = tracker.begin(request);
			set.headers["X-Request-Id"] = context.requestId;
			await services.requests.admit(
				request,
				server?.requestIP(request)?.address ?? null,
			);
			const policy = operationFor(
				request.method,
				new URL(request.url).pathname,
			);
			if (!policy) throw new HttpError("NOT_FOUND");
			if (policy.access !== "public")
				await services.requests.authorize(
					request,
					server?.requestIP(request)?.address ?? null,
					policy.access,
				);
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
		.mapResponse(({ responseValue, request, set, route, path }) => {
			if (
				responseValue instanceof Response ||
				responseValue === undefined ||
				request.method === "HEAD" ||
				request.method === "OPTIONS" ||
				new URL(request.url).pathname === "/metrics"
			)
				return;
			const status = typeof set.status === "number" ? set.status : 200;
			const routePath = route ?? path;
			const key = `${request.method}:${routePath}`;
			let check = responseChecks.get(key);
			if (!check) {
				const declared = app.routes.find(
					(entry) =>
						entry.method === request.method &&
						(entry.path === routePath || `${entry.path}/` === routePath),
				);
				check = responseValidator(declared?.hooks.response);
				responseChecks.set(key, check);
			}
			check(responseValue, status);
			return Response.json(
				success(responseValue, tracker.begin(request).requestId),
				{ status },
			);
		})
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
		.use(healthRoutes(services.health, services.requests))
		.use(validationRoutes(services.validation, services.requests, metrics))
		.use(licenseRoutes(services.licenses, services.requests))
		.use(usageHistoryRoutes(services.usage, services.requests))
		.use(userRoutes(services.users, services.requests))
		.use(groupRoutes(services.groups, services.requests))
		.use(activityRoutes(services.activity, services.requests))
		.use(apiKeyRoutes(services.apiKeys, services.requests))
		.use(settingsRoutes(services.settings, services.requests))
		.use(webhookRoutes(services.webhooks, services.requests))
		.use(metricsRoutes(metrics, services.requests));
	for (const route of app.routes) paths.add(route.path);
	assertOperations(app.routes);
	return app;
};
