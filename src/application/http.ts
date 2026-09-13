import { Elysia } from "elysia";
import { openapi } from "@elysia/openapi";
import type { Type } from "arktype";
import type { OpenAPIV3 } from "openapi-types";
import { AppError, databaseCode } from "../shared/errors.ts";
import type { Services } from "./Services.ts";
import type { Config } from "../shared/Config.ts";
import { ClientIp } from "../shared/ClientIp.ts";
import { RateLimiter } from "../shared/RateLimiter.ts";
import { adminGuard } from "../shared/adminGuard.ts";
import { statusResponse, errorResponse } from "../shared/responses.ts";
import { isMetadataObject } from "../shared/schemas.ts";
import { customerRoutes } from "../customers/routes.ts";
import { licenseRoutes } from "../licenses/routes.ts";
import { accessRoutes } from "../access/routes.ts";
import { activityRoutes } from "../activity/routes.ts";
import { meterRoutes, usageAdminRoutes } from "../meters/routes.ts";
import {
	sessionRoutes,
	sessionAdminRoutes,
	usageRoutes,
} from "../sessions/routes.ts";

export function createHttp(
	config: Config,
	services: Services,
	state: { ready: boolean },
	ip = new ClientIp(config),
) {
	const guard = adminGuard(config.adminKey);
	const rate = new RateLimiter(services.redis, config.rateLimit);
	const app = new Elysia({
		name: "keyzori",
		serve: { maxRequestBodySize: 65536 },
		normalize: false,
	})
		.onError({ as: "global" }, ({ error, code, set }) => {
			let failure: AppError;
			if (error instanceof AppError) failure = error;
			else if (
				code === "VALIDATION" &&
				"type" in error &&
				error.type === "response"
			)
				failure = new AppError(
					"INTERNAL_ERROR",
					"The response could not be produced.",
					500,
				);
			else if (code === "VALIDATION" || code === "PARSE")
				failure = new AppError(
					"VALIDATION_ERROR",
					"Request does not match the documented schema.",
					422,
				);
			else if (code === "NOT_FOUND")
				failure = new AppError("NOT_FOUND", "Route not found.", 404);
			else if (databaseCode(error) === "23505")
				failure = new AppError("CONFLICT", "Resource already exists.", 409);
			else if (databaseCode(error) === "23503")
				failure = new AppError(
					"REFERENCE_CONFLICT",
					"A referenced resource is missing or still in use.",
					409,
				);
			else if (["23514", "22P02", "22023"].includes(databaseCode(error) ?? ""))
				failure = new AppError(
					"INVALID_VALUE",
					"A value violates a storage constraint.",
					400,
				);
			else {
				services.logger.error("request.dependency_or_internal_failure");
				failure = new AppError(
					"UNAVAILABLE",
					"The service cannot complete this request. Try again later.",
					503,
				);
			}
			set.status = failure.status;
			return { error: { code: failure.code, message: failure.message } };
		})
		.onRequest(async ({ request, server, set }) => {
			set.headers["cache-control"] = "no-store";
			const path = new URL(request.url).pathname;
			if (["/health", "/ready", "/docs", "/openapi.json"].includes(path))
				return;
			if (!state.ready)
				throw new AppError("NOT_READY", "Server is not ready.", 503);
			await rate.check(
				ip.resolve(request, server?.requestIP(request)?.address),
				path.startsWith("/admin") ? "admin" : "runtime",
			);
		})
		.use(
			openapi({
				path: "/docs",
				specPath: "/openapi.json",
				mapJsonSchema: {
					arktype: (schema: unknown) =>
						(schema as Type).toJsonSchema({
							fallback: {
								date: () => ({ type: "string", format: "date-time" }),
								predicate: ({ predicate, base }) => {
									// JSON Schema objects already exclude arrays.
									if (predicate === isMetadataObject) return base;
									throw new Error("Undocumented schema predicate.");
								},
							},
						}),
				},
				documentation: {
					openapi: "3.1.0",
					info: { title: "Keyzori", version: "2.0.0" },
					components: {
						schemas: {
							Error: errorResponse.toJsonSchema() as OpenAPIV3.SchemaObject,
						},
						securitySchemes: {
							adminKey: { type: "apiKey", in: "header", name: "X-Admin-Key" },
							session: { type: "http", scheme: "bearer" },
						},
					},
				},
			}),
		)
		.get("/health", () => ({ status: "ok" }), { response: statusResponse })
		.get(
			"/ready",
			async () => {
				if (!state.ready)
					throw new AppError("NOT_READY", "Server is not ready.", 503);
				await Promise.all([
					services.database.ping(),
					services.redis.send("PING", []),
				]);
				return { status: "ready" };
			},
			{ response: statusResponse },
		)
		.use(customerRoutes(services.customers, guard))
		.use(licenseRoutes(services.licenses, services.access, guard))
		.use(accessRoutes(services.access, guard))
		.use(activityRoutes(services.activity, guard))
		.use(meterRoutes(services.meters, guard))
		.use(usageAdminRoutes(services.meters, guard))
		.use(sessionAdminRoutes(services.sessions, guard))
		.use(sessionRoutes(services.sessions, ip))
		.use(usageRoutes(services.sessions, services.meters, ip));
	return { app, guard };
}
