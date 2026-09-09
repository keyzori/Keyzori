import { createHash } from "node:crypto";
import Elysia from "elysia";
import type { LicenseService } from "../application/services/LicenseService";
import { DomainError } from "../domain/errors";
import {
	enforceRateLimit,
	type RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";
import { ClientIpResolver, type ClientIpOptions } from "./clientIp";
import {
	ActivateInputSchema,
	ErrorResponseSchema,
	LicenseSessionResponseSchema,
	SessionInputSchema,
	SuccessResponseSchema,
	UsageInputSchema,
	UsageResponseSchema,
} from "./validation";

export interface LicenseRateLimitOptions {
	limiter: RedisSlidingWindowRateLimiter;
	requestsPerMinute: number;
}

type RuntimeRateLimitScope = "activate" | "heartbeat" | "usage" | "deactivate";

function hashPrincipal(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function licensePlugin(
	licenseService: LicenseService,
	clientIpOptions: ClientIpOptions = {
		trustProxyHeaders: false,
		trustedProxyCidrs: [],
	},
	rateLimitOptions?: LicenseRateLimitOptions,
) {
	const clientIpResolver = new ClientIpResolver(clientIpOptions);
	const limitPrincipal = async (
		scope: RuntimeRateLimitScope,
		principal: string,
		set: Parameters<typeof enforceRateLimit>[3],
	) => {
		if (!rateLimitOptions) return;
		return await enforceRateLimit(
			rateLimitOptions.limiter,
			`ratelimit:license:${scope}:${principal}`,
			rateLimitOptions.requestsPerMinute,
			set,
		);
	};

	return new Elysia({ tags: ["License"], normalize: false })
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
		})
		.post(
			"/v1/activate",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					"activate",
					hashPrincipal(body.licenseKey, body.deviceId),
					set,
				);
				if (limited) return limited;
				return await licenseService.activate(
					body.licenseKey,
					body.deviceId,
					clientIpResolver.resolve(request, server),
				);
			},
			{
				body: ActivateInputSchema,
				response: {
					200: LicenseSessionResponseSchema,
					400: ErrorResponseSchema,
					403: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "activateLicense",
					summary: "Activate a license",
					description:
						"Validates the full license secret once and returns an IP/device-bound session token.",
				},
			},
		)
		.post(
			"/v1/heartbeat",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					"heartbeat",
					hashPrincipal(body.sessionToken),
					set,
				);
				if (limited) return limited;
				return await licenseService.heartbeat(
					body.sessionToken,
					body.deviceId,
					clientIpResolver.resolve(request, server),
				);
			},
			{
				body: SessionInputSchema,
				response: {
					200: LicenseSessionResponseSchema,
					400: ErrorResponseSchema,
					403: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "heartbeatLicense",
					summary: "Refresh a license session",
					description:
						"Rechecks current license policy and refreshes the bound server-issued session.",
				},
			},
		)
		.post(
			"/v1/usage",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					"usage",
					hashPrincipal(body.sessionToken),
					set,
				);
				if (limited) return limited;
				return await licenseService.consume(
					body.sessionToken,
					body.deviceId,
					clientIpResolver.resolve(request, server),
					{
						meter: body.meter,
						units: body.units,
						eventId: body.eventId,
					},
				);
			},
			{
				body: UsageInputSchema,
				response: {
					200: UsageResponseSchema,
					400: ErrorResponseSchema,
					403: ErrorResponseSchema,
					404: ErrorResponseSchema,
					409: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "consumeLicenseUsage",
					summary: "Consume named-meter usage",
					description:
						"Atomically debits a metered license. eventId makes identical retries idempotent.",
				},
			},
		)
		.post(
			"/v1/deactivate",
			async ({ body, request, server, set }) => {
				const limited = await limitPrincipal(
					"deactivate",
					hashPrincipal(body.sessionToken),
					set,
				);
				if (limited) return limited;
				return await licenseService.deactivate(
					body.sessionToken,
					body.deviceId,
					clientIpResolver.resolve(request, server),
				);
			},
			{
				body: SessionInputSchema,
				response: {
					200: SuccessResponseSchema,
					400: ErrorResponseSchema,
					429: ErrorResponseSchema,
					500: ErrorResponseSchema,
				},
				detail: {
					operationId: "deactivateLicense",
					summary: "Release a license session",
					description:
						"Idempotently removes the session instead of waiting for its Redis TTL.",
				},
			},
		);
}
