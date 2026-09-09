import { RedisClient } from "bun";
import { openapi } from "@elysia/openapi";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { version } from "../package.json";
import type { ActivityService } from "./application/services/ActivityService";
import { createServiceGraph } from "./composition/services";
import { loadServerConfig, type ServerConfig } from "./config";
import { adminPlugin } from "./controllers/admin";
import type { ClientIpOptions } from "./controllers/clientIp";
import { licensePlugin } from "./controllers/license";
import { db, type Database } from "./db";
import { migrateDatabase } from "./db/migrate";
import { DomainError } from "./domain/errors";
import { RedisSessionRepository } from "./infrastructure/repositories/RedisSessionRepository";
import {
	createStripeWebhookPlugin,
	StripeGateway,
	StripeSubscriptionService,
	StripeWebhookService,
	StripeWebhookWorker,
} from "./integrations/stripe";
import { openApiDescription } from "./openapi/documentation";
import { scalarThemeCss } from "./openapi/theme";
import { createRateLimitDependencies, rateLimiter } from "./plugins/ratelimit";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface ServerRuntime {
	app: ReturnType<typeof createBaseServer>;
	activityService: ActivityService;
	stripeWorker: StripeWebhookWorker | null;
}

function runtimeConfig(config?: ServerConfig) {
	return {
		clientIpOptions: {
			trustProxyHeaders:
				config?.trustProxyHeaders ??
				Bun.env.KEYZORI_TRUST_PROXY_HEADERS === "true",
			trustedProxyCidrs:
				config?.trustedProxyCidrs ??
				(Bun.env.KEYZORI_TRUSTED_PROXY_CIDRS ?? "")
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			trustedProxyHeader:
				config?.trustedProxyHeader ??
				(Bun.env.KEYZORI_TRUSTED_PROXY_HEADER === "cf-connecting-ip" ||
				Bun.env.KEYZORI_TRUSTED_PROXY_HEADER === "x-real-ip" ||
				Bun.env.KEYZORI_TRUSTED_PROXY_HEADER === "*"
					? Bun.env.KEYZORI_TRUSTED_PROXY_HEADER
					: "x-forwarded-for"),
		} satisfies ClientIpOptions,
		adminRequestsPerMinute:
			config?.rateLimitPerMinute ??
			Number(Bun.env.KEYZORI_RATE_LIMIT_PER_MINUTE ?? 60),
		licenseRequestsPerMinute:
			config?.licenseRateLimitPerMinute ??
			Number(Bun.env.KEYZORI_LICENSE_RATE_LIMIT_PER_MINUTE ?? 30),
		ipRequestsPerMinute:
			config?.rateLimitPerIpPerMinute ??
			Number(Bun.env.KEYZORI_RATE_LIMIT_PER_IP_PER_MINUTE ?? 6_000),
	};
}

function createBaseServer(openapiEnabled: boolean) {
	return new Elysia({ normalize: false })
		.use(
			openapi({
				enabled: openapiEnabled,
				path: "/docs",
				specPath: "/docs/openapi.json",
				provider: "scalar",
				scalar: {
					agent: { disabled: true },
					version: "1.62.9",
					theme: "none",
					layout: "modern",
					darkMode: true,
					showDeveloperTools: false,
					hideDarkModeToggle: true,
					showSidebar: true,
					hideSearch: true,
					hideTestRequestButton: true,
					withDefaultFonts: false,
					defaultOpenAllTags: false,
					defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
					customCss: scalarThemeCss,
				},
				documentation: {
					info: {
						title: "Keyzori API",
						version,
						description: openApiDescription,
						license: {
							name: "Apache License 2.0",
							url: "https://www.apache.org/licenses/LICENSE-2.0",
						},
					},
					servers: [{ url: "/", description: "Current Keyzori server" }],
					tags: [
						{ name: "System", description: "Health and readiness." },
						{
							name: "License",
							description:
								"Runtime activation, heartbeat, usage, and deactivation.",
						},
						{
							name: "Admin",
							description: "Operator-only customer and license management.",
						},
					],
					components: {
						securitySchemes: {
							AdminKey: {
								type: "apiKey",
								in: "header",
								name: "X-Admin-Key",
							},
						},
					},
				},
			}),
		)
		.onError(({ code, error, set }) => {
			if (error instanceof DomainError) {
				set.status = error.statusCode;
				return { error: error.message, code: error.code };
			}
			if (code === "VALIDATION") {
				set.status = 400;
				return {
					error: "Request body or parameters are invalid",
					code: "INVALID_REQUEST" as const,
				};
			}
			if (code === "INTERNAL_SERVER_ERROR" || code === "UNKNOWN") {
				console.error(
					JSON.stringify({ level: "error", event: "request_failed", code }),
				);
				set.status = 500;
				return {
					error: "Internal Server Error",
					code: "INTERNAL_ERROR" as const,
				};
			}
		})
		.onAfterHandle(({ set }) => {
			set.headers["x-content-type-options"] = "nosniff";
			set.headers["x-frame-options"] = "DENY";
			set.headers["referrer-policy"] = "no-referrer";
			set.headers["cache-control"] = "no-store";
		})
		.get("/health", () => ({ status: "ok" as const }), {
			response: t.Object({ status: t.Literal("ok") }),
			detail: {
				operationId: "getHealth",
				summary: "Check service liveness",
				tags: ["System"],
			},
		});
}

function createServerRuntime(
	redis: RedisClient,
	config?: ServerConfig,
	database: Database = db,
): ServerRuntime {
	const settings = runtimeConfig(config);
	const { limiter, clientIpResolver } = createRateLimitDependencies(
		redis,
		settings.clientIpOptions,
	);
	const graph = createServiceGraph(
		new RedisSessionRepository(redis),
		database,
		config?.eventRetentionDays ?? 30,
	);
	const app = createBaseServer(
		config?.openapiEnabled ?? Bun.env.KEYZORI_OPENAPI_ENABLED !== "false",
	);

	app
		.use(rateLimiter(limiter, settings.ipRequestsPerMinute, clientIpResolver))
		.get(
			"/ready",
			async ({ set }) => {
				try {
					await Promise.all([database.execute(sql`select 1`), redis.ping()]);
					return { status: "ready" as const };
				} catch {
					set.status = 503;
					return { status: "unavailable" as const };
				}
			},
			{
				response: {
					200: t.Object({ status: t.Literal("ready") }),
					503: t.Object({ status: t.Literal("unavailable") }),
				},
				detail: {
					operationId: "getReadiness",
					summary: "Check PostgreSQL and Redis readiness",
					tags: ["System"],
				},
			},
		)
		.use(
			licensePlugin(graph.licenseService, settings.clientIpOptions, {
				limiter,
				requestsPerMinute: settings.licenseRequestsPerMinute,
			}),
		);

	let stripeService: StripeSubscriptionService | undefined;
	let stripeWorker: StripeWebhookWorker | null = null;
	if (config?.stripe) {
		const gateway = new StripeGateway(config.stripe);
		stripeService = new StripeSubscriptionService(
			gateway,
			graph.licenseRepository,
			graph.stripeSubscriptionRepository,
			graph.activityService,
		);
		const webhookService = new StripeWebhookService(
			gateway,
			graph.stripeWebhookRepository,
			stripeService,
			graph.activityService,
		);
		stripeWorker = new StripeWebhookWorker(webhookService);
		app.use(
			createStripeWebhookPlugin(webhookService, {
				onWorkAvailable: async () => {
					await stripeWorker?.runOnce();
				},
			}),
		);
	}

	app.use(
		adminPlugin(
			graph.adminService,
			config?.adminPass,
			{
				limiter,
				clientIpResolver,
				requestsPerMinute: settings.adminRequestsPerMinute,
			},
			graph.activityService,
			stripeService,
		),
	);

	return {
		app,
		activityService: graph.activityService,
		stripeWorker,
	};
}

export const createServer = (
	redis: RedisClient,
	config?: ServerConfig,
	database: Database = db,
) => createServerRuntime(redis, config, database).app;

export async function runHealthcheck(): Promise<never> {
	try {
		const port = Bun.env.KEYZORI_SERVER_PORT ?? "3000";
		const response = await fetch(`http://127.0.0.1:${port}/ready`, {
			signal: AbortSignal.timeout(3_000),
		});
		process.exit(response.ok ? 0 : 1);
	} catch {
		process.exit(1);
	}
}

export async function startServer(): Promise<void> {
	const config = loadServerConfig();
	await migrateDatabase();
	const redis = new RedisClient(config.redisUrl);
	await redis.connect();
	const runtime = createServerRuntime(redis, config, db);
	await runtime.activityService
		.pruneExpiredActivity(config.eventRetentionDays)
		.catch((error) => console.error("Initial activity pruning failed", error));
	const pruneTimer = setInterval(() => {
		void runtime.activityService
			.pruneExpiredActivity(config.eventRetentionDays)
			.catch((error) => console.error("Activity pruning failed", error));
	}, DAY_MS);
	pruneTimer.unref?.();
	runtime.stripeWorker?.start();
	const app = runtime.app.listen({
		hostname: config.host,
		port: config.port,
		maxRequestBodySize: config.maxRequestBodyBytes,
	});
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`Received ${signal}; shutting down.`);
		clearInterval(pruneTimer);
		runtime.stripeWorker?.stop();
		await app.stop();
		redis.close();
		await db.$client.close({ timeout: 5 });
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	console.log(
		`Keyzori is running at ${app.server?.hostname}:${app.server?.port}`,
	);
}
