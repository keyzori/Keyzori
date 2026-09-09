import { describe, expect, mock, test } from "bun:test";
import {
	AdminService,
	type CreateLicenseInput,
} from "../application/services/AdminService";
import type {
	Customer,
	License,
	LicenseMeter,
	NewLicense,
	UsageLedgerEntry,
} from "../domain/entities";
import type { IAccessRepository } from "../domain/repositories/IAccessRepository";
import type { ICustomerRepository } from "../domain/repositories/ICustomerRepository";
import type { IDeviceRepository } from "../domain/repositories/IDeviceRepository";
import type { ILicenseRepository } from "../domain/repositories/ILicenseRepository";
import type { IMeterRepository } from "../domain/repositories/IMeterRepository";
import type { ISessionRepository } from "../domain/repositories/ISessionRepository";
import type { IStripeSubscriptionRepository } from "../domain/repositories/IStripeRepository";

const customerFixture: Customer = {
	id: "customer-1",
	email: "owner@example.com",
	name: "Owner",
	metadata: {},
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const licenseFixture: License = {
	id: "license-1",
	keyPrefix: "lic_example",
	customerId: customerFixture.id,
	type: "lifetime",
	maxIps: 0,
	maxDevices: 0,
	maxSessions: 0,
	sessionRevision: 0,
	trialDurationMinutes: 0,
	trialStartedAt: null,
	metadata: {},
	expiresAt: null,
	typeDrafts: { lifetime: {} },
	manualRevokedAt: null,
	manualRevocationReason: null,
	billingRevokedAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function createHarness(initial: Partial<License> = {}) {
	let license = { ...licenseFixture, ...initial };
	let customer = { ...customerFixture };
	const meters: LicenseMeter[] = [];

	const createLicense = mock(async (data: NewLicense) => {
		license = {
			...license,
			...data,
			keyPrefix: data.licenseKey.slice(0, 16),
			manualRevokedAt: null,
			manualRevocationReason: null,
			billingRevokedAt: null,
		};
		for (const input of data.meters) {
			meters.push({
				id: `meter-${meters.length + 1}`,
				licenseId: license.id,
				name: input.name,
				balance: input.balance,
				archivedAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		}
		return { ...license, licenseKey: data.licenseKey };
	});
	const updateLicense = mock(async (_id: string, data: Partial<License>) => {
		license = { ...license, ...data };
		return license;
	});
	const updateWithSessionInvalidation = mock(
		async (_id: string, data: Partial<License>) => {
			license = {
				...license,
				...data,
				sessionRevision: license.sessionRevision + 1,
			};
			return license;
		},
	);
	const licenseRepo: ILicenseRepository = {
		create: createLicense,
		findById: async (id) => (id === license.id ? license : null),
		findByIdWithAllowlists: async (id) =>
			id === license.id
				? { ...license, allowedIps: [], allowedDevices: [] }
				: null,
		findAll: async () => [license],
		update: updateLicense,
		delete: async () => {},
		findByLicenseKeyWithAllowlists: async () => null,
		rotateKey: async (_id, key) => ({
			...license,
			keyPrefix: key.slice(0, 16),
			licenseKey: key,
		}),
		incrementSessionRevision: async () => {
			license = { ...license, sessionRevision: license.sessionRevision + 1 };
			return license;
		},
		updateWithSessionInvalidation,
		updateMeterDraft: async (_id, meterNames) => {
			license = {
				...license,
				typeDrafts: {
					...license.typeDrafts,
					metered: { meterNames: [...meterNames].sort() },
				},
			};
			return license;
		},
		startTrialIfUnset: async () => license,
	};

	const customerRepo: ICustomerRepository = {
		create: async (email, name, metadata) => {
			customer = { ...customer, email, name, metadata };
			return customer;
		},
		findById: async (id) => (id === customer.id ? customer : null),
		findAll: async () => [customer],
		update: async (_id, data) => {
			customer = { ...customer, ...data };
			return customer;
		},
		delete: async () => {},
	};

	const allowedIps: string[] = [];
	const allowedDevices: string[] = [];
	const accessRepo: IAccessRepository = {
		getAccessRecords: async () => ({
			allowedIps: allowedIps.map((ip) => ({
				id: `ip-${ip}`,
				licenseId: license.id,
				ip,
				createdAt: new Date(0),
			})),
			allowedDevices: allowedDevices.map((deviceId) => ({
				id: `device-${deviceId}`,
				licenseId: license.id,
				deviceId,
				createdAt: new Date(0),
			})),
			registeredDevices: [],
			attemptedIps: [],
			attemptedDevices: [],
		}),
		addAllowedIp: async (licenseId, ip) => {
			if (!allowedIps.includes(ip)) allowedIps.push(ip);
			return { id: `ip-${ip}`, licenseId, ip, createdAt: new Date(0) };
		},
		removeAllowedIp: async (_id, ip) => {
			const index = allowedIps.indexOf(ip);
			if (index < 0) return false;
			allowedIps.splice(index, 1);
			return true;
		},
		addAllowedDevice: async (licenseId, deviceId) => {
			if (!allowedDevices.includes(deviceId)) allowedDevices.push(deviceId);
			return {
				id: `device-${deviceId}`,
				licenseId,
				deviceId,
				createdAt: new Date(0),
			};
		},
		removeAllowedDevice: async (_id, deviceId) => {
			const index = allowedDevices.indexOf(deviceId);
			if (index < 0) return false;
			allowedDevices.splice(index, 1);
			return true;
		},
	};

	const removeRegistrationsByIp = mock(async () => 2);
	const removeRegistrationsByDevice = mock(async () => 1);
	const resetRegisteredDevices = mock(async () => 3);
	const deviceRepo: IDeviceRepository = {
		withLicenseRegistrationLock: async (_id, operation) =>
			await operation(deviceRepo),
		findLicenseAdmissionPolicy: async (id) =>
			id === license.id
				? { ...license, allowedIps: [], allowedDevices: [] }
				: null,
		incrementLicenseSessionRevision: async () => {
			license = { ...license, sessionRevision: license.sessionRevision + 1 };
			return license.sessionRevision;
		},
		startTrialIfUnset: async (_id, startedAt) => {
			if (license.type !== "trial") return null;
			if (!license.trialStartedAt) {
				license = { ...license, trialStartedAt: startedAt };
			}
			return license.trialStartedAt;
		},
		findRegisteredDevice: async () => null,
		registerDevice: async () => {
			throw new Error("unused");
		},
		touchDevice: async () => {},
		getLicenseDeviceUsage: async () => ({
			uniqueIps: 0,
			uniqueDevices: 0,
			ipRegistered: false,
			deviceRegistered: false,
		}),
		removeRegisteredDevice: async () => false,
		removeRegistrationsByIp,
		removeRegistrationsByDevice,
		resetRegisteredDevices,
	};

	const removeAllSessions = mock(async () => 2);
	const sessionRepo: ISessionRepository = {
		registerSession: async () => ({ status: "limit-reached" }),
		refreshSession: async () => null,
		removeSession: async () => null,
		removeAllSessions,
	};

	const createMeter = mock(
		async (licenseId: string, name: string, balance: number) => {
			const meter: LicenseMeter = {
				id: `meter-${meters.length + 1}`,
				licenseId,
				name,
				balance,
				archivedAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			meters.push(meter);
			return meter;
		},
	);
	const meterRepo: IMeterRepository = {
		listMeters: async (_id, includeArchived = false) =>
			meters.filter((meter) => includeArchived || !meter.archivedAt),
		createMeter,
		archiveMeter: async (_id, name) => {
			const meter = meters.find((entry) => entry.name === name);
			if (!meter) return null;
			if (
				license.type === "metered" &&
				!meter.archivedAt &&
				meters.filter((entry) => !entry.archivedAt).length === 1
			) {
				return meter;
			}
			meter.archivedAt = new Date();
			return meter;
		},
		consume: async () => ({ status: "not-found" }),
		adjust: async (_id, name, delta, reason, kind) => {
			const meter = meters.find((entry) => entry.name === name);
			if (!meter) return { status: "not-found" };
			const before = meter.balance;
			meter.balance += delta;
			const entry: UsageLedgerEntry = {
				id: "ledger-1",
				licenseId: license.id,
				meterId: meter.id,
				eventId: "operator-1",
				kind,
				delta,
				balanceBefore: before,
				balanceAfter: meter.balance,
				reason,
				createdAt: new Date(),
			};
			return { status: "adjusted", meter, entry };
		},
		listLedger: async () => [],
	};

	let stripeLinked = false;
	const stripeRepo: IStripeSubscriptionRepository = {
		withSubscriptionReconciliationLock: async (_id, operation) =>
			await operation(stripeRepo),
		createForSubscriptionLicense: async () => {
			throw new Error("unused");
		},
		findByLicenseId: async () =>
			stripeLinked
				? {
						id: "link-1",
						licenseId: license.id,
						subscriptionId: "sub_123",
						stripeCustomerId: "cus_123",
						status: "active",
						paidThrough: new Date(Date.now() + 60_000),
						cancelAtPeriodEnd: false,
						priceId: null,
						billingRevokedAt: null,
						lastSyncedAt: new Date(),
						lastError: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					}
				: null,
		findBySubscriptionId: async () => null,
		updateBySubscriptionId: async () => {
			throw new Error("unused");
		},
		reconcileForSubscriptionLicense: async () => {
			throw new Error("unused");
		},
		setBillingRevocation: async () => {
			throw new Error("unused");
		},
		deleteByLicenseId: async () => {
			stripeLinked = false;
			return true;
		},
	};

	const capture = mock(async () => null);
	const service = new AdminService(
		licenseRepo,
		customerRepo,
		accessRepo,
		deviceRepo,
		sessionRepo,
		meterRepo,
		{ capture },
		stripeRepo,
	);
	return {
		service,
		capture,
		createLicense,
		updateLicense,
		updateWithSessionInvalidation,
		createMeter,
		meters,
		removeAllSessions,
		setStripeLinked: (linked: boolean) => {
			stripeLinked = linked;
		},
		setLicense: (data: Partial<License>) => {
			license = { ...license, ...data };
		},
	};
}

describe("AdminService", () => {
	test("normalizes customer naming and metadata", async () => {
		const { service } = createHarness();
		expect(
			await service.createCustomer(" NEW@EXAMPLE.COM ", " New Owner ", {
				company: "Example",
			}),
		).toMatchObject({
			email: "new@example.com",
			name: "New Owner",
			metadata: { company: "Example" },
		});
		await expect(
			service.createCustomer("not-an-email", "Owner"),
		).rejects.toThrow("valid address");
		await expect(
			service.updateCustomer("customer-1", { name: "x".repeat(201) }),
		).rejects.toThrow("between 1 and 200");
	});

	test.each([
		{ type: "lifetime" },
		{ type: "subscription", expiresAt: "2099-01-01T00:00:00.000Z" },
		{ type: "trial", trialDurationMinutes: 60 },
		{
			type: "metered",
			meters: [{ name: "credits", balance: 10, reason: "Initial allocation" }],
		},
	] satisfies Array<Omit<CreateLicenseInput, "customerId">>)(
		"creates a functional $type license",
		async (input) => {
			const { service } = createHarness();
			const license = await service.createLicense({
				customerId: "customer-1",
				...input,
			});
			expect(license.type).toBe(input.type);
			expect(license.licenseKey).toStartWith("lic_");
			expect(license.keyPrefix).toStartWith("lic_");
			expect(license.status).toBe("active");
		},
	);

	test("rejects missing type-specific configuration", async () => {
		const { service } = createHarness();
		expect(
			service.createLicense({ customerId: "customer-1", type: "subscription" }),
		).rejects.toThrow("require expiresAt");
		expect(
			service.createLicense({ customerId: "customer-1", type: "trial" }),
		).rejects.toThrow("trialDurationMinutes");
		expect(
			service.createLicense({ customerId: "customer-1", type: "metered" }),
		).rejects.toThrow("at least one meter");
	});

	test("switches to a fresh trial while retaining the previous type draft", async () => {
		const { service } = createHarness({
			type: "subscription",
			expiresAt: new Date("2099-01-01T00:00:00.000Z"),
			typeDrafts: {
				subscription: { expiresAt: "2099-01-01T00:00:00.000Z" },
			},
		});
		const updated = await service.updateLicense("license-1", {
			type: "trial",
			trialDurationMinutes: 30,
		});
		expect(updated.type).toBe("trial");
		expect(updated.trialStartedAt).toBeInstanceOf(Date);
		expect(updated.typeDrafts.subscription?.expiresAt).toBe(
			"2099-01-01T00:00:00.000Z",
		);
	});

	test("does not erase a concurrently started trial on same-type updates", async () => {
		const harness = createHarness({
			type: "trial",
			trialDurationMinutes: 60,
			trialStartedAt: null,
			typeDrafts: { trial: { durationMinutes: 60 } },
		});
		await harness.service.updateLicense("license-1", {
			metadata: { plan: "updated" },
		});
		const update = harness.updateLicense.mock.calls.at(-1)?.[1];
		expect(update).not.toHaveProperty("trialStartedAt");
	});

	test("requires confirmation before unlinking Stripe during a type change", async () => {
		const harness = createHarness({
			type: "subscription",
			expiresAt: new Date("2099-01-01T00:00:00.000Z"),
		});
		harness.setStripeLinked(true);
		expect(
			harness.service.updateLicense("license-1", { type: "lifetime" }),
		).rejects.toThrow("Confirm unlinkStripe");
		await expect(
			harness.service.updateLicense("license-1", {
				type: "lifetime",
				unlinkStripe: true,
			}),
		).resolves.toMatchObject({ type: "lifetime" });
	});

	test("keeps manual and billing revocation independent", async () => {
		const harness = createHarness({ billingRevokedAt: new Date() });
		const revoked = await harness.service.revokeLicense(
			"license-1",
			"manual review",
		);
		expect(revoked.statusReason).toBe("manual_revocation");
		const restored = await harness.service.restoreLicense("license-1");
		expect(restored.statusReason).toBe("billing_revocation");
	});

	test("fences sessions even when revoke cleanup fails", async () => {
		const harness = createHarness();
		harness.removeAllSessions.mockRejectedValueOnce(
			new Error("Redis unavailable"),
		);
		await expect(
			harness.service.revokeLicense("license-1", "manual review"),
		).resolves.toMatchObject({ statusReason: "manual_revocation" });
		expect(harness.updateWithSessionInvalidation).toHaveBeenCalledTimes(1);
		await expect(
			harness.service.restoreLicense("license-1"),
		).resolves.toMatchObject({ status: "active" });
	});

	test("warns when enabling the first restrictive allowlist", async () => {
		const { service } = createHarness();
		const first = await service.allowLicenseIp("license-1", "203.0.113.10");
		expect(first.restrictionEnabled).toBe(true);
		expect(first.warning).toContain("now restrictive");
		const second = await service.allowLicenseIp("license-1", "203.0.113.11");
		expect(second.restrictionEnabled).toBe(false);
		expect(second.warning).toBeNull();
		const ipv6 = await service.allowLicenseIp(
			"license-1",
			"2001:0DB8:0:0:0:0:0:1",
		);
		expect(ipv6.entry.ip).toBe("2001:db8::1");
		expect(
			await service.removeLicenseAllowedIp("license-1", "2001:db8:0::1"),
		).toBe(true);
	});

	test("releases IP/device slots and terminates bound sessions", async () => {
		const harness = createHarness();
		expect(
			await harness.service.removeRegisteredIp("license-1", "203.0.113.10"),
		).toBe(2);
		expect(
			await harness.service.removeRegisteredDevice("license-1", "device-1"),
		).toBe(1);
		expect(await harness.service.resetRegisteredDevices("license-1")).toBe(3);
		expect(harness.removeAllSessions).toHaveBeenCalledTimes(3);
	});

	test("creates, tops up, adjusts, and protects the final active meter", async () => {
		const harness = createHarness({ type: "metered" });
		const meter = await harness.service.createLicenseMeter("license-1", {
			name: " credits ",
			balance: 10,
			reason: "Initial allocation",
		});
		expect(meter.name).toBe("credits");
		expect(
			await harness.service.topUpLicenseMeter(
				"license-1",
				"credits",
				5,
				"Purchased units",
			),
		).toMatchObject({ balance: 15 });
		expect(
			harness.service.archiveLicenseMeter(
				"license-1",
				"credits",
				"Retired meter",
			),
		).rejects.toThrow("at least one active meter");
	});

	test("never exposes a full key from list or get", async () => {
		const { service } = createHarness();
		const listed = await service.listLicenses();
		expect(listed[0]?.keyPrefix).toBe("lic_example");
		expect(listed[0]).not.toHaveProperty("licenseKey");
		expect(await service.getLicense("license-1")).not.toHaveProperty(
			"licenseKey",
		);
	});
});
