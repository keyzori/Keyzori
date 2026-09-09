import type {
	JsonObject,
	License,
	LicenseType,
	NewActivityEvent,
} from "../../domain/entities";
import { DomainError } from "../../domain/errors";
import { MAX_LICENSE_LIMIT } from "../../domain/licenseLimits";
import { deriveLicenseStatus } from "../../domain/licenseStatus";
import { hashUsageEventId } from "../../domain/usageEvent";
import type { IDeviceRepository } from "../../domain/repositories/IDeviceRepository";
import type {
	ILicenseRepository,
	LicenseWithAllowlists,
} from "../../domain/repositories/ILicenseRepository";
import type { IMeterRepository } from "../../domain/repositories/IMeterRepository";
import type {
	ISessionRepository,
	SessionBinding,
} from "../../domain/repositories/ISessionRepository";
import { type ActivityRecorder, noopActivityRecorder } from "./ActivityService";

export const SESSION_TTL_SECONDS = 45;

export interface LicenseSessionResult {
	success: true;
	licenseType: LicenseType;
	metadata: JsonObject;
	sessionToken: string;
	sessionTtlSeconds: number;
}

export interface ConsumeUsageInput {
	meter: string;
	units: number;
	eventId: string;
}

export interface ConsumeUsageResult {
	success: true;
	meter: string;
	units: number;
	eventId: string;
	remaining: number;
}

function errorReason(error: unknown): string {
	return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

export class LicenseService {
	constructor(
		private readonly licenseRepo: ILicenseRepository,
		private readonly deviceRepo: IDeviceRepository,
		private readonly sessionRepo: ISessionRepository,
		private readonly meterRepo: IMeterRepository,
		private readonly activity: ActivityRecorder = noopActivityRecorder,
	) {}

	async activate(
		licenseKey: string,
		deviceId: string,
		ip: string,
	): Promise<LicenseSessionResult> {
		const binding = this.binding(ip, deviceId);
		let license: LicenseWithAllowlists | null = null;
		try {
			license =
				await this.licenseRepo.findByLicenseKeyWithAllowlists(licenseKey);
			await this.capture({
				type: "license.activation_attempted",
				source: "client",
				licenseId: license?.id,
				customerId: license?.customerId,
				keyPrefix: license?.keyPrefix,
				ip: binding.ip,
				deviceId: binding.deviceId,
			});
			if (!license) {
				throw new DomainError("Invalid license key", 403, "LICENSE_INVALID");
			}
			const admitted = await this.admitActivation(license, binding);
			license = admitted.license;

			await this.capture({
				type: "license.activation_succeeded",
				source: "client",
				licenseId: license.id,
				customerId: license.customerId,
				keyPrefix: license.keyPrefix,
				ip: binding.ip,
				deviceId: binding.deviceId,
			});
			return this.sessionResult(license, admitted.sessionToken);
		} catch (error) {
			await this.capture({
				type: "license.activation_rejected",
				source: "client",
				outcome: "rejected",
				reason: errorReason(error),
				licenseId: license?.id,
				customerId: license?.customerId,
				keyPrefix: license?.keyPrefix,
				ip: binding.ip,
				deviceId: binding.deviceId,
			});
			throw error;
		}
	}

	async heartbeat(
		sessionToken: string,
		deviceId: string,
		ip: string,
	): Promise<LicenseSessionResult> {
		const binding = this.binding(ip, deviceId);
		const resolved = await this.sessionRepo.refreshSession(
			sessionToken,
			binding,
			SESSION_TTL_SECONDS,
		);
		if (!resolved) throw this.invalidSession();
		const license = await this.requireActiveSessionLicense(
			resolved.licenseId,
			resolved.sessionRevision,
			resolved.token,
			binding,
		);
		try {
			const device = await this.deviceRepo.findRegisteredDevice(
				license.id,
				binding.ip,
				binding.deviceId,
			);
			if (device) await this.deviceRepo.touchDevice(device.id, new Date());
		} catch {
			// Last-seen tracking is telemetry and must not invalidate a live license.
		}
		await this.capture({
			type: "license.heartbeat",
			source: "client",
			licenseId: license.id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			ip: binding.ip,
			deviceId: binding.deviceId,
		});
		return this.sessionResult(license, sessionToken);
	}

	async consume(
		sessionToken: string,
		deviceId: string,
		ip: string,
		input: ConsumeUsageInput,
	): Promise<ConsumeUsageResult> {
		const binding = this.binding(ip, deviceId);
		const normalizedInput = {
			meter: input.meter.trim(),
			units: input.units,
			eventId: input.eventId.trim(),
		};
		let license: License | null = null;
		try {
			this.validateUsageInput(normalizedInput);
			const resolved = await this.sessionRepo.refreshSession(
				sessionToken,
				binding,
				SESSION_TTL_SECONDS,
			);
			if (!resolved) throw this.invalidSession();
			license = await this.requireActiveSessionLicense(
				resolved.licenseId,
				resolved.sessionRevision,
				resolved.token,
				binding,
			);
			if (license.type !== "metered") {
				throw new DomainError(
					"Usage can only be consumed from metered licenses",
				);
			}
			const result = await this.meterRepo.consume(
				license.id,
				normalizedInput.meter,
				normalizedInput.units,
				normalizedInput.eventId,
			);
			switch (result.status) {
				case "conflict":
					throw new DomainError(
						"eventId was already used with a different usage request",
						409,
						"USAGE_EVENT_CONFLICT",
					);
				case "not-found":
					throw new DomainError("Meter not found", 404, "METER_NOT_FOUND");
				case "archived":
					throw new DomainError("Meter is archived", 409, "METER_ARCHIVED");
				case "exhausted":
					throw new DomainError(
						"Meter balance is exhausted",
						403,
						"METER_EXHAUSTED",
					);
				default: {
					if (result.status === "consumed") {
						await this.capture({
							type: "usage.consumed",
							source: "client",
							licenseId: license.id,
							customerId: license.customerId,
							keyPrefix: license.keyPrefix,
							ip: binding.ip,
							deviceId: binding.deviceId,
							details: {
								meter: result.meter.name,
								units: normalizedInput.units,
								eventIdHash: hashUsageEventId(normalizedInput.eventId),
								remaining: result.meter.balance,
							},
						});
					}
					return {
						success: true,
						meter: result.meter.name,
						units: normalizedInput.units,
						eventId: normalizedInput.eventId,
						remaining: result.meter.balance,
					};
				}
			}
		} catch (error) {
			await this.capture({
				type: "usage.rejected",
				source: "client",
				outcome: "rejected",
				reason: errorReason(error),
				licenseId: license?.id,
				customerId: license?.customerId,
				keyPrefix: license?.keyPrefix,
				ip: binding.ip,
				deviceId: binding.deviceId,
				details: {
					meter: normalizedInput.meter,
					units: normalizedInput.units,
					eventIdHash: hashUsageEventId(normalizedInput.eventId),
				},
			});
			throw error;
		}
	}

	async deactivate(
		sessionToken: string,
		deviceId: string,
		ip: string,
	): Promise<{ success: true }> {
		const binding = this.binding(ip, deviceId);
		const removed = await this.sessionRepo.removeSession(sessionToken, binding);
		if (removed) {
			let license: License | null = null;
			try {
				license = await this.licenseRepo.findById(removed.licenseId);
			} catch {
				// Enrichment is telemetry only; the Redis session is already removed.
			}
			await this.capture({
				type: "license.deactivated",
				source: "client",
				licenseId: removed.licenseId,
				customerId: license?.customerId,
				keyPrefix: license?.keyPrefix,
				ip: binding.ip,
				deviceId: binding.deviceId,
			});
		}
		return { success: true };
	}

	private async requireActiveSessionLicense(
		licenseId: string,
		sessionRevision: number,
		sessionToken: string,
		binding: SessionBinding,
	): Promise<LicenseWithAllowlists> {
		const license = await this.licenseRepo.findById(licenseId);
		if (!license) {
			await this.removeSessionBestEffort(sessionToken, binding);
			throw this.invalidSession();
		}
		const withAllowlists = await this.licenseRepo.findByIdWithAllowlists(
			license.id,
		);
		if (!withAllowlists) {
			await this.removeSessionBestEffort(sessionToken, binding);
			throw this.invalidSession();
		}
		if (withAllowlists.sessionRevision !== sessionRevision) {
			await this.removeSessionBestEffort(sessionToken, binding);
			throw this.invalidSession();
		}
		try {
			this.assertActive(withAllowlists);
			this.assertAllowed(withAllowlists, binding);
		} catch (error) {
			await this.removeSessionBestEffort(sessionToken, binding);
			throw error;
		}
		return withAllowlists;
	}

	private async admitActivation(
		license: LicenseWithAllowlists,
		binding: SessionBinding,
	): Promise<{ license: LicenseWithAllowlists; sessionToken: string }> {
		let sessionToken: string | null = null;
		let admitted: LicenseWithAllowlists;
		try {
			admitted = await this.deviceRepo.withLicenseRegistrationLock(
				license.id,
				async (deviceRepo) => {
					const current = await deviceRepo.findLicenseAdmissionPolicy(
						license.id,
					);
					if (!current || current.sessionRevision !== license.sessionRevision) {
						throw new DomainError(
							"License changed during activation",
							403,
							"LICENSE_INVALID",
						);
					}
					this.assertActive(current);
					this.assertAllowed(current, binding);

					const existing = await deviceRepo.findRegisteredDevice(
						current.id,
						binding.ip,
						binding.deviceId,
					);
					if (!existing) {
						const usage = await deviceRepo.getLicenseDeviceUsage(
							current.id,
							binding.ip,
							binding.deviceId,
						);
						if (
							current.maxIps > 0 &&
							!usage.ipRegistered &&
							usage.uniqueIps >= current.maxIps
						) {
							throw new DomainError(
								"IP registration limit reached",
								403,
								"IP_REGISTRATION_LIMIT",
							);
						}
						if (
							current.maxDevices > 0 &&
							!usage.deviceRegistered &&
							usage.uniqueDevices >= current.maxDevices
						) {
							throw new DomainError(
								"Device registration limit reached",
								403,
								"DEVICE_REGISTRATION_LIMIT",
							);
						}
					}

					const registration = await this.sessionRepo.registerSession(
						current.id,
						current.sessionRevision,
						binding,
						SESSION_TTL_SECONDS,
						current.maxSessions,
					);
					if (registration.status === "limit-reached") {
						throw new DomainError(
							"Maximum concurrent sessions reached",
							403,
							"CONCURRENT_SESSION_LIMIT",
						);
					}
					sessionToken = registration.token;

					let admittedLicense = current;
					if (current.type === "trial" && !current.trialStartedAt) {
						const trialStartedAt = await deviceRepo.startTrialIfUnset(
							current.id,
							new Date(),
						);
						if (!trialStartedAt) {
							throw new Error("Trial activation could not be persisted.");
						}
						admittedLicense = { ...current, trialStartedAt };
					}
					if (!existing) {
						await deviceRepo.registerDevice(
							current.id,
							binding.ip,
							binding.deviceId,
						);
					}
					return admittedLicense;
				},
			);
		} catch (error) {
			if (sessionToken) {
				try {
					await this.sessionRepo.removeSession(sessionToken, binding);
				} catch {
					// The unreturned token expires naturally if Redis cleanup fails.
				}
			}
			throw error;
		}
		try {
			const device = await this.deviceRepo.findRegisteredDevice(
				admitted.id,
				binding.ip,
				binding.deviceId,
			);
			if (device) await this.deviceRepo.touchDevice(device.id, new Date());
		} catch {
			// Last-seen tracking is telemetry and cannot reject activation.
		}
		if (!sessionToken)
			throw new Error("Session registration did not complete.");
		return { license: admitted, sessionToken };
	}

	private assertActive(license: License): void {
		const status = deriveLicenseStatus(license);
		if (status.status === "revoked") {
			throw new DomainError("License is revoked", 403, "LICENSE_REVOKED");
		}
		if (status.status === "expired") {
			throw new DomainError("License has expired", 403, "LICENSE_EXPIRED");
		}
	}

	private assertAllowed(
		license: LicenseWithAllowlists,
		binding: SessionBinding,
	): void {
		if (
			license.allowedIps.length > 0 &&
			!license.allowedIps.some((entry) => entry.ip === binding.ip)
		) {
			throw new DomainError("IP address is not allowed", 403, "IP_NOT_ALLOWED");
		}
		if (
			license.allowedDevices.length > 0 &&
			!license.allowedDevices.some(
				(entry) => entry.deviceId === binding.deviceId,
			)
		) {
			throw new DomainError("Device is not allowed", 403, "DEVICE_NOT_ALLOWED");
		}
	}

	private binding(ip: string, deviceId: string): SessionBinding {
		const normalizedDeviceId = deviceId.trim();
		if (!normalizedDeviceId || normalizedDeviceId.length > 128) {
			throw new DomainError(
				"deviceId must contain between 1 and 128 characters",
			);
		}
		return { ip: ip.trim(), deviceId: normalizedDeviceId };
	}

	private validateUsageInput(input: ConsumeUsageInput): void {
		if (!input.meter || input.meter.length > 128) {
			throw new DomainError("meter must contain between 1 and 128 characters");
		}
		if (
			!Number.isInteger(input.units) ||
			input.units < 1 ||
			input.units > MAX_LICENSE_LIMIT
		) {
			throw new DomainError(
				`units must be a positive integer no greater than ${MAX_LICENSE_LIMIT}`,
			);
		}
		if (!input.eventId || input.eventId.length > 128) {
			throw new DomainError(
				"eventId must contain between 1 and 128 characters",
			);
		}
	}

	private sessionResult(
		license: License,
		sessionToken: string,
	): LicenseSessionResult {
		return {
			success: true,
			licenseType: license.type,
			metadata: license.metadata,
			sessionToken,
			sessionTtlSeconds: SESSION_TTL_SECONDS,
		};
	}

	private invalidSession(): DomainError {
		return new DomainError(
			"Invalid or expired session token",
			403,
			"SESSION_INVALID_OR_EXPIRED",
		);
	}

	private async removeSessionBestEffort(
		sessionToken: string,
		binding: SessionBinding,
	): Promise<void> {
		try {
			await this.sessionRepo.removeSession(sessionToken, binding);
		} catch {
			// Policy errors remain authoritative when Redis cleanup is unavailable.
		}
	}

	private async capture(event: NewActivityEvent): Promise<void> {
		try {
			await this.activity.capture(event);
		} catch {}
	}
}
