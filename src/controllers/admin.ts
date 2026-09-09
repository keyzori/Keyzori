import { timingSafeEqual } from "node:crypto";
import Elysia, { type Context, t } from "elysia";
import type {
	AdminService,
	ManagedLicense,
	ManagedRevealedLicense,
} from "../application/services/AdminService";
import type { ActivityService } from "../application/services/ActivityService";
import {
	ACTIVITY_EVENT_TYPES,
	type ActivityEvent,
	type ActivityEventType,
	type JsonObject,
	type JsonValue,
} from "../domain/entities";
import { DomainError } from "../domain/errors";
import type { StripeLinkResult } from "../integrations/stripe/StripeSubscriptionService";
import {
	enforceRateLimit,
	type RedisSlidingWindowRateLimiter,
} from "../plugins/ratelimit";
import type { ClientIpResolver } from "./clientIp";
import {
	AccessResponseSchema,
	ConfirmInputSchema,
	CreatedLicenseResponseSchema,
	CustomerInputSchema,
	CustomerPatchSchema,
	CustomerResponseSchema,
	DeviceAllowlistInputSchema,
	IpAllowlistInputSchema,
	LicenseInputSchema,
	LicenseMeterResponseSchema,
	LicensePatchSchema,
	LicenseResponseSchema,
	MeterAdjustmentInputSchema,
	MeterTopUpInputSchema,
	NewMeterInputSchema,
	RevokeInputSchema,
	StripeLinkInputSchema,
	UsageLedgerResponseSchema,
} from "./validation";

function configuredAdminPass(): string {
	return Bun.env.KEYZORI_ADMIN_PASS?.trim() ?? "";
}

function digest(value: string): Uint8Array {
	return new Bun.CryptoHasher("sha256").update(value).digest();
}

export const createAdminAuthMiddleware =
	(expectedPass: string = configuredAdminPass()) =>
	({ request, set }: Context) => {
		const supplied = request.headers.get("x-admin-key");
		const authenticated = Boolean(
			supplied &&
				expectedPass &&
				timingSafeEqual(digest(expectedPass), digest(supplied)),
		);
		if (!authenticated) {
			set.status = 401;
			return { error: "Unauthorized", code: "UNAUTHORIZED" as const };
		}
	};

export interface AdminRateLimitOptions {
	limiter: RedisSlidingWindowRateLimiter;
	clientIpResolver: ClientIpResolver;
	requestsPerMinute: number;
}

export interface StripeAdminOperations {
	linkLicense(
		licenseId: string,
		subscriptionId: string,
	): Promise<StripeLinkResult>;
	unlinkLicense(licenseId: string): Promise<unknown>;
	syncLicense(licenseId: string): Promise<StripeLinkResult | null>;
	getLink(licenseId: string): Promise<unknown>;
}

function presentStripeResult(result: StripeLinkResult | null) {
	if (!result) return null;
	const { sessionRevision: _sessionRevision, ...license } = result.license;
	return { ...result, license };
}

export function presentLicense<
	T extends ManagedLicense | ManagedRevealedLicense,
>(license: T) {
	const { status, statusReason, ...record } = license;
	return { ...record, status: { status, reason: statusReason } };
}

function parseActivityQuery(query: Record<string, unknown>) {
	let type: ActivityEventType | undefined;
	if (query.type !== undefined) {
		if (
			typeof query.type !== "string" ||
			!(ACTIVITY_EVENT_TYPES as readonly string[]).includes(query.type)
		) {
			throw new DomainError("type is not a supported activity event type");
		}
		type = query.type as ActivityEventType;
	}
	const parseDate = (name: "from" | "to"): Date | undefined => {
		const value = query[name];
		if (value === undefined) return undefined;
		if (typeof value !== "string") {
			throw new DomainError(`${name} must be a valid ISO date`);
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			throw new DomainError(`${name} must be a valid ISO date`);
		}
		return date;
	};
	const from = parseDate("from");
	const to = parseDate("to");
	let limit: number | undefined;
	if (query.limit !== undefined) {
		limit = Number(query.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
			throw new DomainError("limit must be an integer from 1 to 1000");
		}
	}
	return {
		...(typeof query.licenseId === "string"
			? { licenseId: query.licenseId }
			: {}),
		...(typeof query.customerId === "string"
			? { customerId: query.customerId }
			: {}),
		...(type ? { type } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		...(limit ? { limit } : {}),
	};
}

function publicDetailValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(publicDetailValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => {
				const normalized = key.replaceAll("_", "").toLowerCase();
				return (
					normalized !== "ip" &&
					normalized !== "deviceid" &&
					normalized !== "hwid"
				);
			})
			.map(([key, child]) => [key, publicDetailValue(child)]),
	);
}

function publicActivity(event: ActivityEvent) {
	const { ip: _ip, deviceId: _deviceId, ...safe } = event;
	return {
		...safe,
		details: publicDetailValue(safe.details) as JsonObject,
	};
}

export function adminPlugin(
	adminService: AdminService,
	adminPass?: string,
	rateLimitOptions?: AdminRateLimitOptions,
	activity?: ActivityService,
	stripe?: StripeAdminOperations,
) {
	const app = new Elysia({
		prefix: "/admin",
		tags: ["Admin"],
		normalize: false,
		detail: { security: [{ AdminKey: [] }] },
	})
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
			if (
				error instanceof Error &&
				"statusCode" in error &&
				Number.isInteger(error.statusCode) &&
				Number(error.statusCode) >= 400 &&
				Number(error.statusCode) < 500
			) {
				set.status = Number(error.statusCode);
				return {
					error: error.message,
					code:
						"code" in error && typeof error.code === "string"
							? error.code
							: "INVALID_REQUEST",
				};
			}
		})
		.onBeforeHandle(async ({ request, server, set }) => {
			if (!rateLimitOptions) return;
			const ip = rateLimitOptions.clientIpResolver.resolve(request, server);
			return await enforceRateLimit(
				rateLimitOptions.limiter,
				`ratelimit:admin:${ip}`,
				rateLimitOptions.requestsPerMinute,
				set,
			);
		})
		.onBeforeHandle(createAdminAuthMiddleware(adminPass))
		.post(
			"/customers",
			async ({ body, set }) => {
				set.status = 201;
				return await adminService.createCustomer(
					body.email,
					body.name,
					body.metadata,
				);
			},
			{ body: CustomerInputSchema, response: { 201: CustomerResponseSchema } },
		)
		.get("/customers", () => adminService.listCustomers(), {
			response: t.Array(CustomerResponseSchema),
		})
		.get(
			"/customers/:id",
			({ params }) => adminService.getCustomer(params.id),
			{
				response: CustomerResponseSchema,
			},
		)
		.patch(
			"/customers/:id",
			({ params, body }) => adminService.updateCustomer(params.id, body),
			{ body: CustomerPatchSchema, response: CustomerResponseSchema },
		)
		.delete("/customers/:id", async ({ params, set }) => {
			await adminService.deleteCustomer(params.id);
			set.status = 204;
		})
		.post(
			"/licenses",
			async ({ body, set }) => {
				const created = await adminService.createLicense(body);
				set.status = 201;
				return presentLicense(created);
			},
			{
				body: LicenseInputSchema,
				response: { 201: CreatedLicenseResponseSchema },
			},
		)
		.get(
			"/licenses",
			async () => (await adminService.listLicenses()).map(presentLicense),
			{ response: t.Array(LicenseResponseSchema) },
		)
		.get(
			"/licenses/:id",
			async ({ params }) =>
				presentLicense(await adminService.getLicense(params.id)),
			{ response: LicenseResponseSchema },
		)
		.patch(
			"/licenses/:id",
			async ({ params, body }) => {
				const { confirmStripeUnlink, ...fields } = body;
				return presentLicense(
					await adminService.updateLicense(params.id, {
						...fields,
						...(confirmStripeUnlink ? { unlinkStripe: true } : {}),
					}),
				);
			},
			{ body: LicensePatchSchema, response: LicenseResponseSchema },
		)
		.delete("/licenses/:id", async ({ params, set }) => {
			await adminService.deleteLicense(params.id);
			set.status = 204;
		})
		.post(
			"/licenses/:id/actions/renew",
			async ({ params, body }) =>
				presentLicense(
					await adminService.renewSubscription(params.id, body.expiresAt),
				),
			{
				body: t.Object(
					{ expiresAt: t.String({ format: "date-time" }) },
					{ additionalProperties: false },
				),
				response: LicenseResponseSchema,
			},
		)
		.post(
			"/licenses/:id/actions/revoke",
			async ({ params, body }) =>
				presentLicense(
					await adminService.revokeLicense(params.id, body.reason),
				),
			{ body: RevokeInputSchema, response: LicenseResponseSchema },
		)
		.post(
			"/licenses/:id/actions/restore",
			async ({ params }) =>
				presentLicense(await adminService.restoreLicense(params.id)),
			{ response: LicenseResponseSchema },
		)
		.post(
			"/licenses/:id/actions/rotate-key",
			async ({ params }) =>
				presentLicense(await adminService.rotateLicenseKey(params.id)),
			{ response: CreatedLicenseResponseSchema },
		)
		.post("/licenses/:id/actions/terminate-sessions", async ({ params }) => ({
			terminated: await adminService.terminateLicenseSessions(params.id),
		}))
		.post("/licenses/:id/actions/reset-devices", async ({ params }) => ({
			removed: await adminService.resetRegisteredDevices(params.id),
		}))
		.get(
			"/licenses/:id/access",
			({ params }) => adminService.getLicenseAccess(params.id),
			{ response: AccessResponseSchema },
		)
		.post(
			"/licenses/:id/allowlists/ips",
			({ params, body }) => adminService.allowLicenseIp(params.id, body.ip),
			{ body: IpAllowlistInputSchema },
		)
		.delete("/licenses/:id/allowlists/ips/:ip", ({ params }) =>
			adminService.removeLicenseAllowedIp(params.id, params.ip),
		)
		.post(
			"/licenses/:id/allowlists/devices",
			({ params, body }) =>
				adminService.allowLicenseDevice(params.id, body.deviceId),
			{ body: DeviceAllowlistInputSchema },
		)
		.delete("/licenses/:id/allowlists/devices/:deviceId", ({ params }) =>
			adminService.removeLicenseAllowedDevice(params.id, params.deviceId),
		)
		.delete("/licenses/:id/registrations/ips/:ip", async ({ params }) => ({
			removed: await adminService.removeRegisteredIp(params.id, params.ip),
		}))
		.delete(
			"/licenses/:id/registrations/devices/:deviceId",
			async ({ params }) => ({
				removed: await adminService.removeRegisteredDevice(
					params.id,
					params.deviceId,
				),
			}),
		)
		.get(
			"/licenses/:id/meters",
			({ params, query }) =>
				adminService.listLicenseMeters(
					params.id,
					String(query.includeArchived ?? "false") === "true",
				),
			{ response: t.Array(LicenseMeterResponseSchema) },
		)
		.post(
			"/licenses/:id/meters",
			({ params, body }) => adminService.createLicenseMeter(params.id, body),
			{ body: NewMeterInputSchema, response: LicenseMeterResponseSchema },
		)
		.post(
			"/licenses/:id/meters/:name/actions/archive",
			({ params, body }) =>
				adminService.archiveLicenseMeter(params.id, params.name, body.reason),
			{ body: RevokeInputSchema, response: LicenseMeterResponseSchema },
		)
		.post(
			"/licenses/:id/meters/:name/actions/top-up",
			({ params, body }) =>
				adminService.topUpLicenseMeter(
					params.id,
					params.name,
					body.units,
					body.reason,
				),
			{ body: MeterTopUpInputSchema, response: LicenseMeterResponseSchema },
		)
		.post(
			"/licenses/:id/meters/:name/actions/adjust",
			({ params, body }) =>
				adminService.adjustLicenseMeter(
					params.id,
					params.name,
					body.delta,
					body.reason,
				),
			{
				body: MeterAdjustmentInputSchema,
				response: LicenseMeterResponseSchema,
			},
		)
		.get(
			"/licenses/:id/usage-ledger",
			({ params, query }) =>
				adminService.listLicenseUsageLedger(
					params.id,
					typeof query.meter === "string" ? query.meter : undefined,
				),
			{ response: t.Array(UsageLedgerResponseSchema) },
		);

	if (activity) {
		app
			.get("/activity", async ({ query }) =>
				(
					await activity.listDetailed(
						parseActivityQuery(query as Record<string, unknown>),
					)
				).map(publicActivity),
			)
			.get("/statistics", async ({ query }) => {
				const statistics = await activity.getStatistics(
					parseActivityQuery(query as Record<string, unknown>),
				);
				return {
					...statistics,
					recent: statistics.recent.map(publicActivity),
				};
			});
	}

	if (stripe) {
		app
			.get("/licenses/:id/stripe", ({ params }) => stripe.getLink(params.id))
			.post(
				"/licenses/:id/actions/link-stripe",
				async ({ params, body }) =>
					presentStripeResult(
						await stripe.linkLicense(params.id, body.subscriptionId),
					),
				{ body: StripeLinkInputSchema },
			)
			.post(
				"/licenses/:id/actions/unlink-stripe",
				({ params }) => stripe.unlinkLicense(params.id),
				{ body: ConfirmInputSchema },
			)
			.post("/licenses/:id/actions/sync-stripe", async ({ params }) =>
				presentStripeResult(await stripe.syncLicense(params.id)),
			);
	}

	return app;
}
