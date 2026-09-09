import { describe, expect, mock, test } from "bun:test";
import Elysia, { type Context } from "elysia";
import type { AdminService } from "../application/services/AdminService";
import type { ActivityService } from "../application/services/ActivityService";
import type { LicenseService } from "../application/services/LicenseService";
import { adminPlugin, createAdminAuthMiddleware } from "../controllers/admin";
import { licensePlugin } from "../controllers/license";
import { ConflictError, DomainError, NotFoundError } from "../domain/errors";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const updatedAt = new Date("2026-01-02T00:00:00.000Z");
const sessionToken = "11111111-1111-4111-8111-111111111111";

const customer = {
	id: "customer-1",
	email: "owner@example.com",
	name: "Owner",
	metadata: { company: "Example Co" },
	createdAt,
	updatedAt,
};

const license = {
	id: "license-1",
	keyPrefix: "lic_01JEXAMPLE",
	customerId: customer.id,
	type: "lifetime" as const,
	maxIps: 2,
	maxDevices: 3,
	maxSessions: 1,
	trialDurationMinutes: 0,
	trialStartedAt: null,
	metadata: { plan: "pro" },
	expiresAt: null,
	typeDrafts: { lifetime: {} },
	manualRevokedAt: null,
	manualRevocationReason: null,
	billingRevokedAt: null,
	createdAt,
	updatedAt,
	status: "active" as const,
	statusReason: null,
};

const revealedLicense = {
	...license,
	licenseKey: "lic_01JEXAMPLE_full_secret",
};

function request(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			...(init?.body === undefined
				? {}
				: { "content-type": "application/json" }),
			...init?.headers,
		},
	});
}

function adminRequest(path: string, init?: RequestInit): Request {
	return request(path, {
		...init,
		headers: {
			"x-admin-key": "admin-secret",
			...init?.headers,
		},
	});
}

describe("license controller", () => {
	test("serves the activate, heartbeat, usage, and deactivate contracts", async () => {
		const service = {
			activate: mock(async () => ({
				success: true as const,
				licenseType: "metered" as const,
				metadata: { plan: "usage" },
				sessionToken,
				sessionTtlSeconds: 45,
			})),
			heartbeat: mock(async () => ({
				success: true as const,
				licenseType: "metered" as const,
				metadata: { plan: "usage" },
				sessionToken,
				sessionTtlSeconds: 45,
			})),
			consume: mock(async () => ({
				success: true as const,
				meter: "builds",
				units: 2,
				eventId: "usage-1",
				remaining: 98,
			})),
			deactivate: mock(async () => ({ success: true as const })),
		} as unknown as LicenseService;
		const app = new Elysia({ normalize: false }).use(licensePlugin(service));

		const activation = await app.handle(
			request("/v1/activate", {
				method: "POST",
				body: JSON.stringify({
					licenseKey: "lic_01JEXAMPLE_full_secret",
					deviceId: "desktop-1",
				}),
			}),
		);
		expect(activation.status).toBe(200);
		expect(await activation.json()).toEqual({
			success: true,
			licenseType: "metered",
			metadata: { plan: "usage" },
			sessionToken,
			sessionTtlSeconds: 45,
		});
		expect(service.activate).toHaveBeenCalledWith(
			"lic_01JEXAMPLE_full_secret",
			"desktop-1",
			"127.0.0.1",
		);

		const heartbeat = await app.handle(
			request("/v1/heartbeat", {
				method: "POST",
				body: JSON.stringify({ sessionToken, deviceId: "desktop-1" }),
			}),
		);
		expect(heartbeat.status).toBe(200);
		expect(service.heartbeat).toHaveBeenCalledWith(
			sessionToken,
			"desktop-1",
			"127.0.0.1",
		);

		const usage = await app.handle(
			request("/v1/usage", {
				method: "POST",
				body: JSON.stringify({
					sessionToken,
					deviceId: "desktop-1",
					meter: "builds",
					units: 2,
					eventId: "usage-1",
				}),
			}),
		);
		expect(usage.status).toBe(200);
		expect(await usage.json()).toEqual({
			success: true,
			meter: "builds",
			units: 2,
			eventId: "usage-1",
			remaining: 98,
		});
		expect(service.consume).toHaveBeenCalledWith(
			sessionToken,
			"desktop-1",
			"127.0.0.1",
			{ meter: "builds", units: 2, eventId: "usage-1" },
		);

		const deactivation = await app.handle(
			request("/v1/deactivate", {
				method: "POST",
				body: JSON.stringify({ sessionToken, deviceId: "desktop-1" }),
			}),
		);
		expect(deactivation.status).toBe(200);
		expect(await deactivation.json()).toEqual({ success: true });
		expect(service.deactivate).toHaveBeenCalledWith(
			sessionToken,
			"desktop-1",
			"127.0.0.1",
		);
	});

	test("maps stable domain errors without exposing secrets", async () => {
		const service = {
			activate: mock(async () => {
				throw new DomainError("Invalid license key", 403, "LICENSE_INVALID");
			}),
		} as unknown as LicenseService;
		const app = new Elysia({ normalize: false }).use(licensePlugin(service));
		const response = await app.handle(
			request("/v1/activate", {
				method: "POST",
				body: JSON.stringify({
					licenseKey: "lic_never_echo_this",
					deviceId: "desktop-1",
				}),
			}),
		);

		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body).toEqual({
			error: "Invalid license key",
			code: "LICENSE_INVALID",
		});
		expect(JSON.stringify(body)).not.toContain("lic_never_echo_this");
	});

	test("rejects removed handshake and legacy payload fields", async () => {
		const service = {
			activate: mock(async () => {
				throw new Error("must not be called");
			}),
		} as unknown as LicenseService;
		const app = new Elysia({ normalize: false }).use(licensePlugin(service));

		const removedRoute = await app.handle(
			request("/v1/handshake", {
				method: "POST",
				body: JSON.stringify({ apiKey: "sk_old", hwid: "old-device" }),
			}),
		);
		expect(removedRoute.status).toBe(404);

		const legacyPayload = await app.handle(
			request("/v1/activate", {
				method: "POST",
				body: JSON.stringify({ apiKey: "sk_old", hwid: "old-device" }),
			}),
		);
		expect(legacyPayload.status).toBe(400);
		expect(await legacyPayload.json()).toMatchObject({
			code: "INVALID_REQUEST",
		});
		expect(service.activate).not.toHaveBeenCalled();

		const mixedPayload = await app.handle(
			request("/v1/activate", {
				method: "POST",
				body: JSON.stringify({
					licenseKey: "lic_current",
					deviceId: "desktop-1",
					apiKey: "sk_old",
					hwid: "old-device",
				}),
			}),
		);
		expect(mixedPayload.status).toBe(400);
		const mixedBody = await mixedPayload.json();
		expect(mixedBody).toMatchObject({ code: "INVALID_REQUEST" });
		expect(JSON.stringify(mixedBody)).not.toContain("lic_current");
		expect(JSON.stringify(mixedBody)).not.toContain("sk_old");
		expect(service.activate).not.toHaveBeenCalled();
	});
});

describe("admin controller", () => {
	test("accepts the configured admin password", () => {
		const previous = Bun.env.KEYZORI_ADMIN_PASS;
		try {
			Bun.env.KEYZORI_ADMIN_PASS = "admin-secret";
			const middleware = createAdminAuthMiddleware();
			const set = { headers: {} } as Context["set"];
			const result = middleware({
				request: request("/admin/licenses", {
					headers: { "x-admin-key": "admin-secret" },
				}),
				set,
			} as Context);
			expect(result).toBeUndefined();
			expect(set.status).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.KEYZORI_ADMIN_PASS;
			else Bun.env.KEYZORI_ADMIN_PASS = previous;
		}
	});

	test("serves canonical customer and license routes with one-time key exposure", async () => {
		const revoked = {
			...license,
			manualRevokedAt: updatedAt,
			manualRevocationReason: "Operator request",
			status: "revoked" as const,
			statusReason: "manual_revocation" as const,
		};
		const service = {
			createCustomer: mock(async () => customer),
			listCustomers: mock(async () => [customer]),
			getCustomer: mock(async () => customer),
			updateCustomer: mock(async () => ({
				...customer,
				name: "Updated owner",
			})),
			deleteCustomer: mock(async () => {}),
			createLicense: mock(async () => revealedLicense),
			listLicenses: mock(async () => [license]),
			getLicense: mock(async () => license),
			updateLicense: mock(async () => ({ ...license, maxDevices: 5 })),
			deleteLicense: mock(async () => {}),
			revokeLicense: mock(async () => revoked),
			restoreLicense: mock(async () => license),
			rotateLicenseKey: mock(async () => ({
				...revealedLicense,
				licenseKey: "lic_01JROTATED_full_secret",
				keyPrefix: "lic_01JROTATED",
			})),
			terminateLicenseSessions: mock(async () => 2),
			resetRegisteredDevices: mock(async () => 3),
		} as unknown as AdminService;
		const app = new Elysia({ normalize: false }).use(
			adminPlugin(service, "admin-secret"),
		);

		const mixedLicense = await app.handle(
			adminRequest("/admin/licenses", {
				method: "POST",
				body: JSON.stringify({
					customerId: customer.id,
					type: "lifetime",
					limitHwid: 4,
				}),
			}),
		);
		expect(mixedLicense.status).toBe(400);
		expect(service.createLicense).not.toHaveBeenCalled();

		const createdCustomer = await app.handle(
			adminRequest("/admin/customers", {
				method: "POST",
				body: JSON.stringify({
					email: customer.email,
					name: customer.name,
					metadata: customer.metadata,
				}),
			}),
		);
		expect(createdCustomer.status).toBe(201);
		expect(service.createCustomer).toHaveBeenCalledWith(
			customer.email,
			customer.name,
			customer.metadata,
		);

		const customerList = await app.handle(adminRequest("/admin/customers"));
		expect(customerList.status).toBe(200);
		expect(await customerList.json()).toHaveLength(1);

		const created = await app.handle(
			adminRequest("/admin/licenses", {
				method: "POST",
				body: JSON.stringify({ customerId: customer.id, type: "lifetime" }),
			}),
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			id: license.id,
			licenseKey: revealedLicense.licenseKey,
			keyPrefix: license.keyPrefix,
			status: { status: "active", reason: null },
		});

		const listed = await app.handle(adminRequest("/admin/licenses"));
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as Array<Record<string, unknown>>;
		expect(listedBody).toHaveLength(1);
		expect(listedBody[0]?.keyPrefix).toBe(license.keyPrefix);
		expect(listedBody[0]).not.toHaveProperty("licenseKey");

		const fetched = await app.handle(
			adminRequest(`/admin/licenses/${license.id}`),
		);
		expect(fetched.status).toBe(200);
		expect(await fetched.json()).not.toHaveProperty("licenseKey");

		const updated = await app.handle(
			adminRequest(`/admin/licenses/${license.id}`, {
				method: "PATCH",
				body: JSON.stringify({ maxDevices: 5, metadata: { plan: "team" } }),
			}),
		);
		expect(updated.status).toBe(200);
		expect(service.updateLicense).toHaveBeenCalledWith(license.id, {
			maxDevices: 5,
			metadata: { plan: "team" },
		});

		const revoke = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/actions/revoke`, {
				method: "POST",
				body: JSON.stringify({ reason: "Operator request" }),
			}),
		);
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toMatchObject({
			status: { status: "revoked", reason: "manual_revocation" },
		});

		const restore = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/actions/restore`, {
				method: "POST",
			}),
		);
		expect(restore.status).toBe(200);

		const rotate = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/actions/rotate-key`, {
				method: "POST",
			}),
		);
		expect(rotate.status).toBe(200);
		expect(await rotate.json()).toMatchObject({
			licenseKey: "lic_01JROTATED_full_secret",
			keyPrefix: "lic_01JROTATED",
		});

		const terminate = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/actions/terminate-sessions`, {
				method: "POST",
			}),
		);
		expect(await terminate.json()).toEqual({ terminated: 2 });

		const reset = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/actions/reset-devices`, {
				method: "POST",
			}),
		);
		expect(await reset.json()).toEqual({ removed: 3 });
	});

	test("serves canonical access and named-meter management routes", async () => {
		const access = {
			allowedIps: [],
			allowedDevices: [],
			registeredDevices: [
				{
					id: "registration-1",
					licenseId: license.id,
					ip: "203.0.113.10",
					deviceId: "desktop-1",
					createdAt,
					lastSeenAt: updatedAt,
				},
			],
			attemptedIps: [],
			attemptedDevices: [],
		};
		const meter = {
			id: "meter-1",
			licenseId: license.id,
			name: "builds",
			balance: 100,
			archivedAt: null,
			createdAt,
			updatedAt,
		};
		const ledger = {
			id: "ledger-1",
			licenseId: license.id,
			meterId: meter.id,
			eventId: "operator-ledger-1",
			kind: "top_up" as const,
			delta: 10,
			balanceBefore: 90,
			balanceAfter: 100,
			reason: "Monthly allocation",
			createdAt,
		};
		const service = {
			getLicenseAccess: mock(async () => access),
			allowLicenseIp: mock(async () => ({
				entry: {
					id: "allowed-ip-1",
					licenseId: license.id,
					ip: "198.51.100.20",
					createdAt,
				},
				restrictionEnabled: true,
				warning: "IP allowlisting is now restrictive.",
			})),
			allowLicenseDevice: mock(async () => ({
				entry: {
					id: "allowed-device-1",
					licenseId: license.id,
					deviceId: "desktop-2",
					createdAt,
				},
				restrictionEnabled: true,
				warning: "Device allowlisting is now restrictive.",
			})),
			removeRegisteredIp: mock(async () => 1),
			removeRegisteredDevice: mock(async () => 1),
			listLicenseMeters: mock(async () => [meter]),
			createLicenseMeter: mock(async () => meter),
			topUpLicenseMeter: mock(async () => meter),
			adjustLicenseMeter: mock(async () => meter),
			archiveLicenseMeter: mock(async () => ({
				...meter,
				archivedAt: updatedAt,
			})),
			listLicenseUsageLedger: mock(async () => [ledger]),
		} as unknown as AdminService;
		const app = new Elysia({ normalize: false }).use(
			adminPlugin(service, "admin-secret"),
		);

		const accessResponse = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/access`),
		);
		expect(accessResponse.status).toBe(200);
		expect(await accessResponse.json()).toMatchObject({
			registeredDevices: [{ deviceId: "desktop-1" }],
		});

		const allowIp = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/allowlists/ips`, {
				method: "POST",
				body: JSON.stringify({ ip: "198.51.100.20" }),
			}),
		);
		expect(allowIp.status).toBe(200);
		expect(service.allowLicenseIp).toHaveBeenCalledWith(
			license.id,
			"198.51.100.20",
		);

		const allowDevice = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/allowlists/devices`, {
				method: "POST",
				body: JSON.stringify({ deviceId: "desktop-2" }),
			}),
		);
		expect(allowDevice.status).toBe(200);
		expect(service.allowLicenseDevice).toHaveBeenCalledWith(
			license.id,
			"desktop-2",
		);

		const removeIp = await app.handle(
			adminRequest(
				`/admin/licenses/${license.id}/registrations/ips/203.0.113.10`,
				{ method: "DELETE" },
			),
		);
		expect(await removeIp.json()).toEqual({ removed: 1 });

		const removeDevice = await app.handle(
			adminRequest(
				`/admin/licenses/${license.id}/registrations/devices/desktop-1`,
				{ method: "DELETE" },
			),
		);
		expect(await removeDevice.json()).toEqual({ removed: 1 });

		const meters = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/meters`),
		);
		expect(meters.status).toBe(200);
		expect(await meters.json()).toMatchObject([
			{ name: "builds", balance: 100 },
		]);

		const createMeter = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/meters`, {
				method: "POST",
				body: JSON.stringify({
					name: "builds",
					balance: 100,
					reason: "Initial allocation",
				}),
			}),
		);
		expect(createMeter.status).toBe(200);
		expect(service.createLicenseMeter).toHaveBeenCalledWith(license.id, {
			name: "builds",
			balance: 100,
			reason: "Initial allocation",
		});

		const topUp = await app.handle(
			adminRequest(
				`/admin/licenses/${license.id}/meters/builds/actions/top-up`,
				{
					method: "POST",
					body: JSON.stringify({
						units: 10,
						reason: "Monthly allocation",
					}),
				},
			),
		);
		expect(topUp.status).toBe(200);
		expect(service.topUpLicenseMeter).toHaveBeenCalledWith(
			license.id,
			"builds",
			10,
			"Monthly allocation",
		);

		const adjust = await app.handle(
			adminRequest(
				`/admin/licenses/${license.id}/meters/builds/actions/adjust`,
				{
					method: "POST",
					body: JSON.stringify({ delta: -2, reason: "Correction" }),
				},
			),
		);
		expect(adjust.status).toBe(200);
		expect(service.adjustLicenseMeter).toHaveBeenCalledWith(
			license.id,
			"builds",
			-2,
			"Correction",
		);

		const archive = await app.handle(
			adminRequest(
				`/admin/licenses/${license.id}/meters/builds/actions/archive`,
				{
					method: "POST",
					body: JSON.stringify({ reason: "Retired meter" }),
				},
			),
		);
		expect(archive.status).toBe(200);
		expect(service.archiveLicenseMeter).toHaveBeenCalledWith(
			license.id,
			"builds",
			"Retired meter",
		);

		const ledgerResponse = await app.handle(
			adminRequest(`/admin/licenses/${license.id}/usage-ledger?meter=builds`),
		);
		expect(ledgerResponse.status).toBe(200);
		expect(await ledgerResponse.json()).toMatchObject([
			{ meterId: meter.id, kind: "top_up", delta: 10 },
		]);
		expect(service.listLicenseUsageLedger).toHaveBeenCalledWith(
			license.id,
			"builds",
		);
	});

	test("requires authentication and removes legacy admin resources", async () => {
		const service = {
			listCustomers: mock(async () => [customer]),
			listLicenses: mock(async () => [license]),
		} as unknown as AdminService;
		const app = new Elysia({ normalize: false }).use(
			adminPlugin(service, "admin-secret"),
		);

		const unauthorized = await app.handle(request("/admin/licenses"));
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toEqual({
			error: "Unauthorized",
			code: "UNAUTHORIZED",
		});

		for (const path of ["/admin/users", "/admin/keys"]) {
			const removed = await app.handle(adminRequest(path));
			expect(removed.status).toBe(404);
		}
	});

	test("keeps exact access identifiers out of global activity responses", async () => {
		const service = {} as AdminService;
		const activity = {
			listDetailed: mock(async () => [
				{
					id: "event-1",
					type: "license.updated" as const,
					source: "operator" as const,
					outcome: "success" as const,
					reason: null,
					licenseId: license.id,
					customerId: customer.id,
					keyPrefix: license.keyPrefix,
					ip: "203.0.113.10",
					deviceId: "private-device",
					details: {
						action: "allow_ip",
						ip: "203.0.113.10",
						nested: { deviceId: "private-device", safe: true },
					},
					createdAt,
				},
			]),
		} as unknown as ActivityService;
		const app = new Elysia({ normalize: false }).use(
			adminPlugin(service, "admin-secret", undefined, activity),
		);

		const response = await app.handle(adminRequest("/admin/activity"));
		expect(response.status).toBe(200);
		const [event] = (await response.json()) as Array<Record<string, unknown>>;
		expect(event).not.toHaveProperty("ip");
		expect(event).not.toHaveProperty("deviceId");
		expect(event?.details).toEqual({
			action: "allow_ip",
			nested: { safe: true },
		});
	});

	test("maps canonical domain, conflict, and validation failures", async () => {
		const service = {
			createCustomer: mock(async () => {
				throw new ConflictError("A customer with this email already exists");
			}),
			getLicense: mock(async () => {
				throw new NotFoundError("License", "LICENSE_INVALID");
			}),
		} as unknown as AdminService;
		const app = new Elysia({ normalize: false }).use(
			adminPlugin(service, "admin-secret"),
		);

		const duplicate = await app.handle(
			adminRequest("/admin/customers", {
				method: "POST",
				body: JSON.stringify({
					email: "duplicate@example.com",
					name: "Owner",
				}),
			}),
		);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			error: "A customer with this email already exists",
			code: "INVALID_REQUEST",
		});

		const missing = await app.handle(adminRequest("/admin/licenses/missing"));
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: "License not found",
			code: "LICENSE_INVALID",
		});

		const invalid = await app.handle(
			adminRequest("/admin/licenses", {
				method: "POST",
				body: JSON.stringify({ customerId: customer.id, type: "PERPETUAL" }),
			}),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toHaveProperty("code", "INVALID_REQUEST");
	});
});
