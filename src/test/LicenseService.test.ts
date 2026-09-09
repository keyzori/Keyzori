import { describe, expect, mock, test } from "bun:test";
import { LicenseService } from "../application/services/LicenseService";
import type {
	License,
	LicenseMeter,
	RegisteredDevice,
	UsageLedgerEntry,
} from "../domain/entities";
import { type ApiErrorCode, DomainError } from "../domain/errors";
import type { IDeviceRepository } from "../domain/repositories/IDeviceRepository";
import type {
	ILicenseRepository,
	LicenseWithAllowlists,
} from "../domain/repositories/ILicenseRepository";
import type {
	IMeterRepository,
	UsageConsumptionResult,
} from "../domain/repositories/IMeterRepository";
import type { ISessionRepository } from "../domain/repositories/ISessionRepository";

const baseLicense: LicenseWithAllowlists = {
	id: "license-1",
	keyPrefix: "lic_example",
	customerId: "customer-1",
	type: "lifetime",
	maxIps: 0,
	maxDevices: 0,
	maxSessions: 0,
	sessionRevision: 0,
	trialDurationMinutes: 0,
	trialStartedAt: null,
	metadata: { tier: "pro" },
	expiresAt: null,
	typeDrafts: { lifetime: {} },
	manualRevokedAt: null,
	manualRevocationReason: null,
	billingRevokedAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	allowedIps: [],
	allowedDevices: [],
};

function createHarness(overrides: Partial<LicenseWithAllowlists> = {}) {
	let license = { ...baseLicense, ...overrides };
	const update = mock(async (_id: string, data: Partial<License>) => {
		license = { ...license, ...data };
		return license;
	});
	const startLicenseTrialIfUnset = mock(
		async (_id: string, startedAt: Date) => {
			if (!license.trialStartedAt)
				license = { ...license, trialStartedAt: startedAt };
			return license;
		},
	);
	const findByLicenseKeyWithAllowlists = mock(async (value: string) =>
		value === "lic_valid" ? license : null,
	);
	const findById = mock(async (id: string) =>
		id === license.id ? license : null,
	);
	const licenseRepo: ILicenseRepository = {
		create: async () => ({ ...license, licenseKey: "lic_created" }),
		findById,
		findByIdWithAllowlists: async (id) => (id === license.id ? license : null),
		findAll: async () => [license],
		update,
		delete: async () => {},
		findByLicenseKeyWithAllowlists,
		rotateKey: async () => ({ ...license, licenseKey: "lic_rotated" }),
		incrementSessionRevision: async () => {
			license = { ...license, sessionRevision: license.sessionRevision + 1 };
			return license;
		},
		updateWithSessionInvalidation: async (_id, data) => {
			license = {
				...license,
				...data,
				sessionRevision: license.sessionRevision + 1,
			};
			return license;
		},
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
		startTrialIfUnset: startLicenseTrialIfUnset,
	};

	const device: RegisteredDevice = {
		id: "device-row-1",
		licenseId: license.id,
		ip: "203.0.113.10",
		deviceId: "device-1",
		createdAt: new Date(0),
		lastSeenAt: new Date(0),
	};
	const findRegisteredDevice = mock(
		async (): Promise<RegisteredDevice | null> => null,
	);
	const getLicenseDeviceUsage = mock(async () => ({
		uniqueIps: 0,
		uniqueDevices: 0,
		ipRegistered: false,
		deviceRegistered: false,
	}));
	const registerDevice = mock(async () => device);
	const touchDevice = mock(async () => {});
	const findLicenseAdmissionPolicy = mock(
		async (id: string): Promise<LicenseWithAllowlists | null> =>
			id === license.id ? license : null,
	);
	const startTrialIfUnset = mock(async (_id: string, startedAt: Date) => {
		if (license.type !== "trial") return null;
		if (!license.trialStartedAt) {
			license = { ...license, trialStartedAt: startedAt };
		}
		return license.trialStartedAt;
	});
	const deviceRepo: IDeviceRepository = {
		withLicenseRegistrationLock: async (_id, operation) =>
			await operation(deviceRepo),
		findLicenseAdmissionPolicy,
		incrementLicenseSessionRevision: async () => {
			license = { ...license, sessionRevision: license.sessionRevision + 1 };
			return license.sessionRevision;
		},
		startTrialIfUnset,
		findRegisteredDevice,
		registerDevice,
		touchDevice,
		getLicenseDeviceUsage,
		removeRegisteredDevice: async () => false,
		removeRegistrationsByIp: async () => 0,
		removeRegistrationsByDevice: async () => 0,
		resetRegisteredDevices: async () => 0,
	};

	const registerSession = mock(async () => ({
		status: "registered" as const,
		token: "session-token",
	}));
	const refreshSession = mock(async () => ({
		licenseId: license.id,
		sessionRevision: license.sessionRevision,
		token: "session-token",
	}));
	const removeSession = mock(async () => ({
		licenseId: license.id,
		sessionRevision: license.sessionRevision,
		token: "session-token",
	}));
	const sessionRepo: ISessionRepository = {
		registerSession,
		refreshSession,
		removeSession,
		removeAllSessions: async () => 0,
	};

	const meter: LicenseMeter = {
		id: "meter-1",
		licenseId: license.id,
		name: "credits",
		balance: 7,
		archivedAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const ledger: UsageLedgerEntry = {
		id: "ledger-1",
		licenseId: license.id,
		meterId: meter.id,
		eventId: "event-1",
		kind: "consume",
		delta: -3,
		balanceBefore: 10,
		balanceAfter: 7,
		reason: null,
		createdAt: new Date(0),
	};
	const consume = mock(
		async (): Promise<UsageConsumptionResult> => ({
			status: "consumed",
			meter,
			entry: ledger,
		}),
	);
	const meterRepo: IMeterRepository = {
		listMeters: async () => [meter],
		createMeter: async () => meter,
		archiveMeter: async () => meter,
		consume,
		adjust: async () => ({ status: "out-of-range" }),
		listLedger: async () => [ledger],
	};

	const capture = mock(async () => null);
	return {
		service: new LicenseService(
			licenseRepo,
			deviceRepo,
			sessionRepo,
			meterRepo,
			{ capture },
		),
		capture,
		consume,
		deviceRepo,
		findById,
		findByLicenseKeyWithAllowlists,
		findRegisteredDevice,
		getLicenseDeviceUsage,
		findLicenseAdmissionPolicy,
		registerDevice,
		registerSession,
		refreshSession,
		removeSession,
		startTrialIfUnset,
		touchDevice,
		setLicense: (data: Partial<LicenseWithAllowlists>) => {
			license = { ...license, ...data };
		},
	};
}

async function expectCode(promise: Promise<unknown>, code: ApiErrorCode) {
	try {
		await promise;
		throw new Error("Expected promise to reject");
	} catch (error) {
		expect(error).toBeInstanceOf(DomainError);
		expect((error as DomainError).code).toBe(code);
	}
}

describe("LicenseService", () => {
	test("activates a lifetime license and returns only runtime metadata", async () => {
		const harness = createHarness();
		expect(
			await harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
		).toEqual({
			success: true,
			licenseType: "lifetime",
			metadata: { tier: "pro" },
			sessionToken: "session-token",
			sessionTtlSeconds: 45,
		});
		expect(harness.registerDevice).toHaveBeenCalledTimes(1);
		expect(harness.consume).not.toHaveBeenCalled();
	});

	test("uses distinct invalid, revoked, and expired errors", async () => {
		await expectCode(
			createHarness().service.activate("bad", "device-1", "203.0.113.10"),
			"LICENSE_INVALID",
		);
		await expectCode(
			createHarness({ manualRevokedAt: new Date() }).service.activate(
				"lic_valid",
				"device-1",
				"203.0.113.10",
			),
			"LICENSE_REVOKED",
		);
		await expectCode(
			createHarness({
				type: "subscription",
				expiresAt: new Date(0),
			}).service.activate("lic_valid", "device-1", "203.0.113.10"),
			"LICENSE_EXPIRED",
		);
	});

	test("starts a trial atomically on its first successful activation", async () => {
		const harness = createHarness({
			type: "trial",
			trialDurationMinutes: 60,
			trialStartedAt: null,
		});
		await harness.service.activate("lic_valid", "device-1", "203.0.113.10");
		expect(harness.startTrialIfUnset).toHaveBeenCalledTimes(1);
	});

	test("rejects an activation whose key is rotated during admission", async () => {
		const harness = createHarness();
		harness.findLicenseAdmissionPolicy.mockResolvedValueOnce(null);
		await expectCode(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
			"LICENSE_INVALID",
		);
		expect(harness.registerSession).not.toHaveBeenCalled();
	});

	test("rejects an activation fenced while registration is locked", async () => {
		const harness = createHarness();
		harness.findLicenseAdmissionPolicy.mockResolvedValueOnce({
			...baseLicense,
			sessionRevision: 1,
		});
		await expectCode(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
			"LICENSE_INVALID",
		);
		expect(harness.registerDevice).not.toHaveBeenCalled();
		expect(harness.registerSession).not.toHaveBeenCalled();
	});

	test("enforces current allowlists and registration limits", async () => {
		await expectCode(
			createHarness({
				allowedIps: [
					{
						id: "allow-1",
						licenseId: "license-1",
						ip: "198.51.100.2",
						createdAt: new Date(0),
					},
				],
			}).service.activate("lic_valid", "device-1", "203.0.113.10"),
			"IP_NOT_ALLOWED",
		);
		const limited = createHarness({ maxDevices: 1 });
		limited.getLicenseDeviceUsage.mockResolvedValueOnce({
			uniqueIps: 1,
			uniqueDevices: 1,
			ipRegistered: true,
			deviceRegistered: false,
		});
		await expectCode(
			limited.service.activate("lic_valid", "device-2", "203.0.113.10"),
			"DEVICE_REGISTRATION_LIMIT",
		);
		expect(limited.registerSession).not.toHaveBeenCalled();
	});

	test("uses the locked current type and session limit during admission", async () => {
		const harness = createHarness({ type: "lifetime", maxSessions: 0 });
		harness.findLicenseAdmissionPolicy.mockResolvedValueOnce({
			...baseLicense,
			type: "subscription",
			expiresAt: new Date("2099-01-01T00:00:00.000Z"),
			maxSessions: 1,
		});
		await expect(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
		).resolves.toMatchObject({ licenseType: "subscription" });
		expect(harness.registerSession).toHaveBeenCalledWith(
			"license-1",
			0,
			{ ip: "203.0.113.10", deviceId: "device-1" },
			45,
			1,
		);
	});

	test("removes a reserved session when database admission fails", async () => {
		const harness = createHarness();
		harness.registerDevice.mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		await expect(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
		).rejects.toThrow("database unavailable");
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
	});

	test("heartbeats preserve the token and apply status changes immediately", async () => {
		const harness = createHarness();
		expect(
			await harness.service.heartbeat(
				"session-token",
				"device-1",
				"203.0.113.10",
			),
		).toMatchObject({ sessionToken: "session-token" });
		harness.setLicense({ billingRevokedAt: new Date() });
		await expectCode(
			harness.service.heartbeat("session-token", "device-1", "203.0.113.10"),
			"LICENSE_REVOKED",
		);
		expect(harness.removeSession).toHaveBeenCalledTimes(1);
	});

	test("session cleanup failure cannot mask a policy rejection", async () => {
		const harness = createHarness({ sessionRevision: 1 });
		harness.refreshSession.mockResolvedValueOnce({
			licenseId: "license-1",
			sessionRevision: 0,
			token: "session-token",
		});
		harness.removeSession.mockRejectedValueOnce(new Error("Redis unavailable"));
		await expectCode(
			harness.service.heartbeat("session-token", "device-1", "203.0.113.10"),
			"SESSION_INVALID_OR_EXPIRED",
		);
	});

	test("consumes named meter units explicitly and normalizes idempotency values", async () => {
		const harness = createHarness({ type: "metered" });
		expect(
			await harness.service.consume(
				"session-token",
				"device-1",
				"203.0.113.10",
				{ meter: " credits ", units: 3, eventId: " event-1 " },
			),
		).toEqual({
			success: true,
			meter: "credits",
			units: 3,
			eventId: "event-1",
			remaining: 7,
		});
		expect(harness.consume).toHaveBeenCalledWith(
			"license-1",
			"credits",
			3,
			"event-1",
		);
	});

	test.each([
		["conflict", "USAGE_EVENT_CONFLICT"],
		["not-found", "METER_NOT_FOUND"],
		["archived", "METER_ARCHIVED"],
		["exhausted", "METER_EXHAUSTED"],
	] as const)("maps %s meter results", async (status, code) => {
		const harness = createHarness({ type: "metered" });
		harness.consume.mockResolvedValueOnce({ status });
		await expectCode(
			harness.service.consume("session-token", "device-1", "203.0.113.10", {
				meter: "credits",
				units: 1,
				eventId: "event-1",
			}),
			code,
		);
	});

	test("activity failure never blocks licensing", async () => {
		const harness = createHarness();
		harness.capture.mockRejectedValue(new Error("telemetry offline"));
		await expect(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
		).resolves.toMatchObject({ success: true });
	});

	test("last-seen telemetry failure never blocks heartbeats", async () => {
		const harness = createHarness();
		harness.deviceRepo.findRegisteredDevice = async () => {
			throw new Error("access telemetry offline");
		};
		await expect(
			harness.service.heartbeat("session-token", "device-1", "203.0.113.10"),
		).resolves.toMatchObject({ success: true });
	});

	test("last-seen telemetry failure never blocks reactivation", async () => {
		const harness = createHarness();
		harness.findRegisteredDevice.mockResolvedValue({
			id: "device-row-1",
			licenseId: "license-1",
			ip: "203.0.113.10",
			deviceId: "device-1",
			createdAt: new Date(0),
			lastSeenAt: new Date(0),
		});
		harness.touchDevice.mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		await expect(
			harness.service.activate("lic_valid", "device-1", "203.0.113.10"),
		).resolves.toMatchObject({ success: true });
	});

	test("deactivation succeeds after removal when telemetry lookup fails", async () => {
		const harness = createHarness();
		harness.findById.mockRejectedValueOnce(new Error("database unavailable"));
		await expect(
			harness.service.deactivate("session-token", "device-1", "203.0.113.10"),
		).resolves.toEqual({ success: true });
	});
});
