import type {
	Customer,
	DeviceAllowlistEntry,
	EffectiveLicenseStatus,
	IpAllowlistEntry,
	JsonObject,
	License,
	LicenseMeter,
	LicenseType,
	LicenseTypeDrafts,
	NewActivityEvent,
	NewLicenseMeter,
	RevealedLicense,
	UsageLedgerEntry,
} from "../../domain/entities";
import { randomBytes } from "node:crypto";
import { ConflictError, DomainError, NotFoundError } from "../../domain/errors";
import { MAX_LICENSE_LIMIT } from "../../domain/licenseLimits";
import { deriveLicenseStatus } from "../../domain/licenseStatus";
import { normalizeIpAddress } from "../../domain/ipAddress";
import type {
	AccessRecords,
	IAccessRepository,
} from "../../domain/repositories/IAccessRepository";
import type { ICustomerRepository } from "../../domain/repositories/ICustomerRepository";
import type { IDeviceRepository } from "../../domain/repositories/IDeviceRepository";
import type {
	ILicenseRepository,
	LicenseUpdate,
} from "../../domain/repositories/ILicenseRepository";
import type { IMeterRepository } from "../../domain/repositories/IMeterRepository";
import type { ISessionRepository } from "../../domain/repositories/ISessionRepository";
import type { IStripeSubscriptionRepository } from "../../domain/repositories/IStripeRepository";
import { type ActivityRecorder, noopActivityRecorder } from "./ActivityService";

export interface CreateMeterInput {
	name: string;
	balance: number;
	reason: string;
}

export interface CreateLicenseInput {
	customerId: string;
	type: LicenseType;
	maxIps?: number;
	maxDevices?: number;
	maxSessions?: number;
	trialDurationMinutes?: number;
	metadata?: JsonObject;
	expiresAt?: string;
	meters?: CreateMeterInput[];
}

export interface UpdateLicenseInput {
	customerId?: string;
	type?: LicenseType;
	maxIps?: number;
	maxDevices?: number;
	maxSessions?: number;
	trialDurationMinutes?: number;
	metadata?: JsonObject;
	expiresAt?: string | null;
	meters?: CreateMeterInput[];
	unlinkStripe?: boolean;
}

export interface UpdateCustomerInput {
	email?: string;
	name?: string;
	metadata?: JsonObject;
}

export interface ManagedLicense extends Omit<License, "sessionRevision"> {
	status: EffectiveLicenseStatus["status"];
	statusReason: EffectiveLicenseStatus["reason"];
}

export interface ManagedRevealedLicense
	extends Omit<RevealedLicense, "sessionRevision"> {
	status: EffectiveLicenseStatus["status"];
	statusReason: EffectiveLicenseStatus["reason"];
}

export interface AllowlistChange<T> {
	entry: T;
	restrictionEnabled: boolean;
	warning: string | null;
}

function validateInteger(value: number, label: string, minimum = 0): void {
	if (
		!Number.isInteger(value) ||
		value < minimum ||
		value > MAX_LICENSE_LIMIT
	) {
		throw new DomainError(
			`${label} must be an integer from ${minimum} to ${MAX_LICENSE_LIMIT}`,
		);
	}
}

function customerEmail(value: string): string {
	const email = value.trim().toLowerCase();
	if (
		!email ||
		email.length > 254 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
	) {
		throw new DomainError("Customer email must be a valid address");
	}
	return email;
}

function customerName(value: string): string {
	const name = value.trim();
	if (!name || name.length > 200) {
		throw new DomainError(
			"Customer name must contain between 1 and 200 characters",
		);
	}
	return name;
}

function parseFutureDate(value: string, label = "expiresAt"): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
		throw new DomainError(`${label} must be a valid future date`);
	}
	return date;
}

function managed<T extends License>(
	license: T,
): Omit<T, "sessionRevision"> & ManagedLicense {
	const effective = deriveLicenseStatus(license);
	const { sessionRevision: _sessionRevision, ...publicLicense } = license;
	return {
		...publicLicense,
		status: effective.status,
		statusReason: effective.reason,
	};
}

function licenseKey(): string {
	return `lic_${randomBytes(32).toString("base64url")}`;
}

export class AdminService {
	constructor(
		private readonly licenseRepo: ILicenseRepository,
		private readonly customerRepo: ICustomerRepository,
		private readonly accessRepo: IAccessRepository,
		private readonly deviceRepo: IDeviceRepository,
		private readonly sessionRepo: ISessionRepository,
		private readonly meterRepo: IMeterRepository,
		private readonly activity: ActivityRecorder = noopActivityRecorder,
		private readonly stripeRepo?: IStripeSubscriptionRepository,
	) {}

	async createCustomer(
		email: string,
		name: string,
		metadata: JsonObject = {},
	): Promise<Customer> {
		const normalizedEmail = customerEmail(email);
		const normalizedName = customerName(name);
		const customer = await this.customerRepo.create(
			normalizedEmail,
			normalizedName,
			metadata,
		);
		await this.capture({
			type: "customer.created",
			source: "operator",
			customerId: customer.id,
		});
		return customer;
	}

	async listCustomers(): Promise<Customer[]> {
		return await this.customerRepo.findAll();
	}

	async getCustomer(id: string): Promise<Customer> {
		const customer = await this.customerRepo.findById(id);
		if (!customer) throw new NotFoundError("Customer");
		return customer;
	}

	async updateCustomer(
		id: string,
		data: UpdateCustomerInput,
	): Promise<Customer> {
		await this.getCustomer(id);
		if (Object.keys(data).length === 0) {
			throw new DomainError("At least one customer field is required");
		}
		const email =
			data.email === undefined ? undefined : customerEmail(data.email);
		const name = data.name === undefined ? undefined : customerName(data.name);
		const customer = await this.customerRepo.update(id, {
			...(email === undefined ? {} : { email }),
			...(name === undefined ? {} : { name }),
			...(data.metadata === undefined ? {} : { metadata: data.metadata }),
		});
		await this.capture({
			type: "customer.updated",
			source: "operator",
			customerId: id,
			details: { fields: Object.keys(data) },
		});
		return customer;
	}

	async deleteCustomer(id: string): Promise<void> {
		await this.getCustomer(id);
		const licenses = (await this.licenseRepo.findAll()).filter(
			(license) => license.customerId === id,
		);
		await this.customerRepo.delete(id);
		const cleanup = await Promise.all(
			licenses.map((license) => this.removeSessionsBestEffort(license.id)),
		);
		await this.capture({
			type: "customer.deleted",
			source: "operator",
			customerId: id,
			details: {
				cleanupFailures: cleanup.filter((result) => result.failed).length,
			},
		});
	}

	async createLicense(
		data: CreateLicenseInput,
	): Promise<ManagedRevealedLicense> {
		if (!(await this.customerRepo.findById(data.customerId))) {
			throw new NotFoundError("Customer");
		}
		const maxIps = data.maxIps ?? 0;
		const maxDevices = data.maxDevices ?? 0;
		const maxSessions = data.maxSessions ?? 0;
		validateInteger(maxIps, "maxIps");
		validateInteger(maxDevices, "maxDevices");
		validateInteger(maxSessions, "maxSessions");
		const meters = this.validateMeters(data.meters ?? []);
		const typeConfig = this.createTypeConfig(data, meters);
		const license = await this.licenseRepo.create({
			licenseKey: licenseKey(),
			customerId: data.customerId,
			type: data.type,
			maxIps,
			maxDevices,
			maxSessions,
			trialDurationMinutes: typeConfig.trialDurationMinutes,
			trialStartedAt: null,
			metadata: data.metadata ?? {},
			expiresAt: typeConfig.expiresAt,
			typeDrafts: typeConfig.typeDrafts,
			meters,
		});
		await this.capture({
			type: "license.created",
			source: "operator",
			licenseId: license.id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			details: { licenseType: license.type },
		});
		return managed(license);
	}

	async listLicenses(): Promise<ManagedLicense[]> {
		return (await this.licenseRepo.findAll()).map(managed);
	}

	async getLicense(id: string): Promise<ManagedLicense> {
		return managed(await this.requireLicense(id));
	}

	async updateLicense(
		id: string,
		data: UpdateLicenseInput,
	): Promise<ManagedLicense> {
		const fields = Object.keys(data);
		if (
			fields.length === 0 ||
			fields.every((field) => field === "unlinkStripe")
		) {
			throw new DomainError("At least one license field is required");
		}
		const current = await this.requireLicense(id);
		for (const [label, value] of [
			["maxIps", data.maxIps],
			["maxDevices", data.maxDevices],
			["maxSessions", data.maxSessions],
		] as const) {
			if (value !== undefined) validateInteger(value, label);
		}
		const customerId = data.customerId ?? current.customerId;
		if (
			data.customerId !== undefined &&
			!(await this.customerRepo.findById(customerId))
		) {
			throw new NotFoundError("Customer");
		}
		const targetType = data.type ?? current.type;
		const typeChanged = targetType !== current.type;
		if (targetType !== "subscription" && data.expiresAt !== undefined) {
			throw new DomainError(
				"expiresAt is only valid for subscription licenses",
			);
		}
		if (targetType !== "trial" && data.trialDurationMinutes !== undefined) {
			throw new DomainError(
				"trialDurationMinutes is only valid for trial licenses",
			);
		}

		const newMeters = this.validateMeters(data.meters ?? []);
		if (targetType !== "metered" && newMeters.length > 0) {
			throw new DomainError("meters are only valid for metered licenses");
		}
		const currentMeters = await this.meterRepo.listMeters(id, false);
		const drafts = this.withCurrentDraft(
			current,
			current.type === "metered"
				? currentMeters.map((meter) => meter.name)
				: [],
		);
		const active = this.updateTypeConfig(
			current,
			data,
			targetType,
			typeChanged,
			drafts,
		);

		if (targetType === "metered") {
			const activeNames = new Set(currentMeters.map((meter) => meter.name));
			const allMeters = new Map(
				(await this.meterRepo.listMeters(id, true)).map((meter) => [
					meter.name,
					{ archivedAt: meter.archivedAt, balance: meter.balance },
				]),
			);
			for (const meter of newMeters) {
				const existing = allMeters.get(meter.name);
				if (existing) {
					if (existing.archivedAt || existing.balance !== meter.balance) {
						throw new ConflictError(`Meter ${meter.name} already exists`);
					}
				} else {
					allMeters.set(meter.name, {
						archivedAt: null,
						balance: meter.balance,
					});
				}
				activeNames.add(meter.name);
			}
			if (activeNames.size === 0) {
				throw new DomainError("Metered licenses require at least one meter");
			}
			active.typeDrafts.metered = { meterNames: [...activeNames].sort() };
		}

		let stripeLink = null;
		if (
			this.stripeRepo &&
			(targetType !== "subscription" || data.expiresAt !== undefined)
		) {
			stripeLink = await this.stripeRepo.findByLicenseId(id);
			if (
				stripeLink &&
				targetType === "subscription" &&
				data.expiresAt !== undefined
			) {
				throw new ConflictError(
					"Stripe-managed subscriptions cannot be renewed manually; sync or unlink Stripe first",
				);
			}
			if (stripeLink && !data.unlinkStripe) {
				throw new ConflictError(
					"Confirm unlinkStripe when changing a Stripe-linked subscription license",
				);
			}
		}

		const metersToCreate = newMeters.filter(
			(meter) =>
				!currentMeters.some((existing) => existing.name === meter.name),
		);
		const update: LicenseUpdate = {
			customerId,
			type: targetType,
			maxIps: data.maxIps ?? current.maxIps,
			maxDevices: data.maxDevices ?? current.maxDevices,
			maxSessions: data.maxSessions ?? current.maxSessions,
			trialDurationMinutes: active.trialDurationMinutes,
			...(typeChanged ? { trialStartedAt: active.trialStartedAt } : {}),
			metadata: data.metadata ?? current.metadata,
			expiresAt: active.expiresAt,
			typeDrafts: active.typeDrafts,
		};
		const updated = await this.licenseRepo.update(id, update, {
			confirmStripeUnlink: data.unlinkStripe === true,
			expectedUpdatedAt: current.updatedAt,
			manualExpiresAtUpdate: data.expiresAt !== undefined,
			newMeters: metersToCreate,
		});
		if (stripeLink && this.stripeRepo) {
			await this.stripeRepo.deleteByLicenseId(id);
			await this.capture({
				type: "stripe.unlinked",
				source: "operator",
				licenseId: id,
				customerId: updated.customerId,
				keyPrefix: updated.keyPrefix,
				details: { subscriptionId: stripeLink.subscriptionId },
			});
		}
		await this.capture({
			type: typeChanged ? "license.type_changed" : "license.updated",
			source: "operator",
			licenseId: id,
			customerId: updated.customerId,
			keyPrefix: updated.keyPrefix,
			details: typeChanged
				? { from: current.type, to: updated.type }
				: { fields: fields.filter((field) => field !== "unlinkStripe") },
		});
		return managed(updated);
	}

	async renewSubscription(
		id: string,
		expiresAt: string,
	): Promise<ManagedLicense> {
		const current = await this.requireLicense(id);
		if (current.type !== "subscription") {
			throw new DomainError("Only subscription licenses can be renewed");
		}
		return await this.updateLicense(id, { expiresAt });
	}

	async deleteLicense(id: string): Promise<void> {
		const license = await this.requireLicense(id);
		await this.licenseRepo.delete(id);
		const cleanup = await this.removeSessionsBestEffort(id);
		await this.capture({
			type: "license.deleted",
			source: "operator",
			licenseId: id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			details: { cleanupFailed: cleanup.failed },
		});
	}

	async revokeLicense(
		id: string,
		reason = "Revoked by operator",
	): Promise<ManagedLicense> {
		const license = await this.requireLicense(id);
		const normalizedReason = this.reason(reason);
		const updated = await this.licenseRepo.updateWithSessionInvalidation(id, {
			manualRevokedAt: license.manualRevokedAt ?? new Date(),
			manualRevocationReason: normalizedReason,
		});
		const cleanup = await this.removeSessionsBestEffort(
			id,
			updated.sessionRevision,
		);
		await this.capture({
			type: "license.revoked",
			source: "operator",
			licenseId: id,
			customerId: updated.customerId,
			keyPrefix: updated.keyPrefix,
			reason: normalizedReason,
			details: { cleanupFailed: cleanup.failed },
		});
		return managed(updated);
	}

	async restoreLicense(id: string): Promise<ManagedLicense> {
		await this.requireLicense(id);
		const updated = await this.licenseRepo.update(id, {
			manualRevokedAt: null,
			manualRevocationReason: null,
		});
		await this.capture({
			type: "license.restored",
			source: "operator",
			licenseId: id,
			customerId: updated.customerId,
			keyPrefix: updated.keyPrefix,
		});
		return managed(updated);
	}

	async rotateLicenseKey(id: string): Promise<ManagedRevealedLicense> {
		const current = await this.requireLicense(id);
		const rotated = await this.licenseRepo.rotateKey(
			id,
			licenseKey(),
			current.updatedAt,
		);
		const cleanup = await this.removeSessionsBestEffort(
			id,
			rotated.sessionRevision,
		);
		await this.capture({
			type: "license.key_rotated",
			source: "operator",
			licenseId: id,
			customerId: current.customerId,
			keyPrefix: rotated.keyPrefix,
			details: { cleanupFailed: cleanup.failed },
		});
		return managed(rotated);
	}

	async getLicenseAccess(id: string): Promise<AccessRecords> {
		await this.requireLicense(id);
		return await this.accessRepo.getAccessRecords(id);
	}

	async allowLicenseIp(
		id: string,
		value: string,
	): Promise<AllowlistChange<IpAllowlistEntry>> {
		const license = await this.requireLicense(id);
		const ip = normalizeIpAddress(value);
		if (!ip) throw new DomainError("A valid IPv4 or IPv6 address is required");
		const before = await this.accessRepo.getAccessRecords(id);
		const entry = await this.accessRepo.addAllowedIp(id, ip);
		const restrictionEnabled = before.allowedIps.length === 0;
		await this.captureLicenseUpdate(license, "allow_ip", { ip });
		return {
			entry,
			restrictionEnabled,
			warning: restrictionEnabled
				? "IP allowlisting is now restrictive; only listed IP addresses can activate or continue sessions."
				: null,
		};
	}

	async removeLicenseAllowedIp(id: string, value: string): Promise<boolean> {
		const license = await this.requireLicense(id);
		const ip = normalizeIpAddress(value);
		if (!ip) throw new DomainError("A valid IPv4 or IPv6 address is required");
		const removed = await this.accessRepo.removeAllowedIp(id, ip);
		if (removed) await this.captureLicenseUpdate(license, "remove_allowed_ip");
		return removed;
	}

	async allowLicenseDevice(
		id: string,
		value: string,
	): Promise<AllowlistChange<DeviceAllowlistEntry>> {
		const license = await this.requireLicense(id);
		const deviceId = this.deviceId(value);
		const before = await this.accessRepo.getAccessRecords(id);
		const entry = await this.accessRepo.addAllowedDevice(id, deviceId);
		const restrictionEnabled = before.allowedDevices.length === 0;
		await this.captureLicenseUpdate(license, "allow_device", { deviceId });
		return {
			entry,
			restrictionEnabled,
			warning: restrictionEnabled
				? "Device allowlisting is now restrictive; only listed device IDs can activate or continue sessions."
				: null,
		};
	}

	async removeLicenseAllowedDevice(
		id: string,
		value: string,
	): Promise<boolean> {
		const license = await this.requireLicense(id);
		const removed = await this.accessRepo.removeAllowedDevice(
			id,
			this.deviceId(value),
		);
		if (removed)
			await this.captureLicenseUpdate(license, "remove_allowed_device");
		return removed;
	}

	async removeRegisteredIp(id: string, value: string): Promise<number> {
		const license = await this.requireLicense(id);
		const ip = normalizeIpAddress(value);
		if (!ip) throw new DomainError("A valid IPv4 or IPv6 address is required");
		const result = await this.deviceRepo.withLicenseRegistrationLock(
			id,
			async (repository) => {
				const count = await repository.removeRegistrationsByIp(id, ip);
				const sessionRevision =
					count > 0
						? await repository.incrementLicenseSessionRevision(id)
						: null;
				return { count, sessionRevision };
			},
		);
		if (result.count > 0) {
			await this.removeSessionsBestEffort(
				id,
				result.sessionRevision ?? undefined,
			);
			await this.captureLicenseUpdate(license, "remove_registered_ip", {
				removed: result.count,
			});
		}
		return result.count;
	}

	async removeRegisteredDevice(id: string, value: string): Promise<number> {
		const license = await this.requireLicense(id);
		const deviceId = this.deviceId(value);
		const result = await this.deviceRepo.withLicenseRegistrationLock(
			id,
			async (repository) => {
				const count = await repository.removeRegistrationsByDevice(
					id,
					deviceId,
				);
				const sessionRevision =
					count > 0
						? await repository.incrementLicenseSessionRevision(id)
						: null;
				return { count, sessionRevision };
			},
		);
		if (result.count > 0) {
			await this.removeSessionsBestEffort(
				id,
				result.sessionRevision ?? undefined,
			);
			await this.captureLicenseUpdate(license, "remove_registered_device", {
				removed: result.count,
			});
		}
		return result.count;
	}

	async resetRegisteredDevices(id: string): Promise<number> {
		const license = await this.requireLicense(id);
		const result = await this.deviceRepo.withLicenseRegistrationLock(
			id,
			async (repository) => {
				const count = await repository.resetRegisteredDevices(id);
				const sessionRevision =
					await repository.incrementLicenseSessionRevision(id);
				return { count, sessionRevision };
			},
		);
		await this.removeSessionsBestEffort(
			id,
			result.sessionRevision ?? undefined,
		);
		await this.captureLicenseUpdate(license, "reset_registered_devices", {
			removed: result.count,
		});
		return result.count;
	}

	async terminateLicenseSessions(id: string): Promise<number> {
		const license = await this.requireLicense(id);
		const updated = await this.licenseRepo.incrementSessionRevision(id);
		const cleanup = await this.removeSessionsBestEffort(
			id,
			updated.sessionRevision,
		);
		const removed = cleanup.removed;
		await this.captureLicenseUpdate(license, "terminate_sessions", { removed });
		return removed;
	}

	async listLicenseMeters(
		id: string,
		includeArchived = false,
	): Promise<LicenseMeter[]> {
		await this.requireLicense(id);
		return await this.meterRepo.listMeters(id, includeArchived);
	}

	async createLicenseMeter(
		id: string,
		data: CreateMeterInput,
	): Promise<LicenseMeter> {
		const license = await this.requireLicense(id);
		const [meterInput] = this.validateMeters([data]);
		if (!meterInput) throw new DomainError("Meter is required");
		const meter = await this.meterRepo.createMeter(
			id,
			meterInput.name,
			meterInput.balance,
			meterInput.reason,
		);
		await this.updateMeterDraft(license);
		await this.capture({
			type: "meter.created",
			source: "operator",
			licenseId: id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			reason: meterInput.reason,
			details: { meter: meter.name, balance: meter.balance },
		});
		return meter;
	}

	async archiveLicenseMeter(
		id: string,
		name: string,
		reason: string,
	): Promise<LicenseMeter> {
		const license = await this.requireLicense(id);
		const meterName = this.meterName(name);
		const normalizedReason = this.reason(reason);
		const meter = await this.meterRepo.archiveMeter(
			id,
			meterName,
			normalizedReason,
		);
		if (!meter) throw new NotFoundError("Meter", "METER_NOT_FOUND");
		if (!meter.archivedAt) {
			throw new ConflictError(
				"A metered license must keep at least one active meter",
			);
		}
		await this.updateMeterDraft(license);
		await this.capture({
			type: "meter.archived",
			source: "operator",
			licenseId: id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			reason: normalizedReason,
			details: { meter: meter.name },
		});
		return meter;
	}

	async topUpLicenseMeter(
		id: string,
		name: string,
		units: number,
		reason: string,
	): Promise<LicenseMeter> {
		validateInteger(units, "units", 1);
		return await this.adjustMeter(id, name, units, reason, "top_up");
	}

	async adjustLicenseMeter(
		id: string,
		name: string,
		delta: number,
		reason: string,
	): Promise<LicenseMeter> {
		if (
			!Number.isInteger(delta) ||
			delta === 0 ||
			Math.abs(delta) > MAX_LICENSE_LIMIT
		) {
			throw new DomainError(
				`delta must be a non-zero integer between -${MAX_LICENSE_LIMIT} and ${MAX_LICENSE_LIMIT}`,
			);
		}
		return await this.adjustMeter(id, name, delta, reason, "adjustment");
	}

	async listLicenseUsageLedger(
		id: string,
		meterName?: string,
	): Promise<UsageLedgerEntry[]> {
		await this.requireLicense(id);
		return await this.meterRepo.listLedger(
			id,
			meterName === undefined ? undefined : this.meterName(meterName),
		);
	}

	private async adjustMeter(
		id: string,
		name: string,
		delta: number,
		reason: string,
		kind: "top_up" | "adjustment",
	): Promise<LicenseMeter> {
		const license = await this.requireLicense(id);
		const normalizedReason = this.reason(reason);
		const result = await this.meterRepo.adjust(
			id,
			this.meterName(name),
			delta,
			normalizedReason,
			kind,
		);
		switch (result.status) {
			case "not-found":
				throw new NotFoundError("Meter", "METER_NOT_FOUND");
			case "archived":
				throw new ConflictError("Meter is archived", "METER_ARCHIVED");
			case "out-of-range":
				throw new DomainError(
					`Adjustment would move balance outside 0 to ${MAX_LICENSE_LIMIT}`,
				);
			default:
				await this.capture({
					type: "meter.adjusted",
					source: "operator",
					licenseId: id,
					customerId: license.customerId,
					keyPrefix: license.keyPrefix,
					reason: normalizedReason,
					details: {
						meter: result.meter.name,
						delta,
						balance: result.meter.balance,
						kind,
					},
				});
				return result.meter;
		}
	}

	private async removeSessionsBestEffort(
		licenseId: string,
		preserveFromRevision?: number,
	): Promise<{ removed: number; failed: boolean }> {
		try {
			return {
				removed: await this.sessionRepo.removeAllSessions(
					licenseId,
					preserveFromRevision,
				),
				failed: false,
			};
		} catch {
			return { removed: 0, failed: true };
		}
	}

	private createTypeConfig(
		data: CreateLicenseInput,
		meters: NewLicenseMeter[],
	): {
		expiresAt: Date | null;
		trialDurationMinutes: number;
		typeDrafts: LicenseTypeDrafts;
	} {
		if (data.type === "subscription") {
			if (!data.expiresAt) {
				throw new DomainError("Subscription licenses require expiresAt");
			}
			if (data.trialDurationMinutes !== undefined) {
				throw new DomainError(
					"trialDurationMinutes is only valid for trial licenses",
				);
			}
			if (meters.length > 0) {
				throw new DomainError("meters are only valid for metered licenses");
			}
			const expiresAt = parseFutureDate(data.expiresAt);
			return {
				expiresAt,
				trialDurationMinutes: 0,
				typeDrafts: {
					subscription: { expiresAt: expiresAt.toISOString() },
				},
			};
		}
		if (data.type === "trial") {
			const duration = data.trialDurationMinutes ?? 0;
			validateInteger(duration, "trialDurationMinutes", 1);
			if (data.expiresAt) {
				throw new DomainError(
					"expiresAt is only valid for subscription licenses",
				);
			}
			if (meters.length > 0) {
				throw new DomainError("meters are only valid for metered licenses");
			}
			return {
				expiresAt: null,
				trialDurationMinutes: duration,
				typeDrafts: { trial: { durationMinutes: duration } },
			};
		}
		if (data.type === "metered") {
			if (meters.length === 0) {
				throw new DomainError("Metered licenses require at least one meter");
			}
			if (data.expiresAt || data.trialDurationMinutes !== undefined) {
				throw new DomainError(
					"expiresAt and trialDurationMinutes are not valid for metered licenses",
				);
			}
			return {
				expiresAt: null,
				trialDurationMinutes: 0,
				typeDrafts: {
					metered: { meterNames: meters.map((meter) => meter.name).sort() },
				},
			};
		}
		if (
			data.expiresAt ||
			data.trialDurationMinutes !== undefined ||
			meters.length
		) {
			throw new DomainError(
				"Lifetime licenses do not accept expiry, trial, or meter settings",
			);
		}
		return {
			expiresAt: null,
			trialDurationMinutes: 0,
			typeDrafts: { lifetime: {} },
		};
	}

	private updateTypeConfig(
		current: License,
		data: UpdateLicenseInput,
		targetType: LicenseType,
		typeChanged: boolean,
		drafts: LicenseTypeDrafts,
	): {
		expiresAt: Date | null;
		trialDurationMinutes: number;
		trialStartedAt: Date | null;
		typeDrafts: LicenseTypeDrafts;
	} {
		if (targetType === "subscription") {
			if (data.expiresAt === null) {
				throw new DomainError("Subscription licenses require expiresAt");
			}
			let expiresAt: Date | null = null;
			if (data.expiresAt) expiresAt = parseFutureDate(data.expiresAt);
			else if (!typeChanged) expiresAt = current.expiresAt;
			else {
				const draft = drafts.subscription?.expiresAt;
				if (draft) expiresAt = parseFutureDate(draft);
			}
			if (!expiresAt) {
				throw new DomainError("Subscription licenses require expiresAt");
			}
			drafts.subscription = { expiresAt: expiresAt.toISOString() };
			return {
				expiresAt,
				trialDurationMinutes: 0,
				trialStartedAt: null,
				typeDrafts: drafts,
			};
		}
		if (targetType === "trial") {
			const duration =
				data.trialDurationMinutes ??
				(typeChanged
					? drafts.trial?.durationMinutes
					: current.trialDurationMinutes);
			if (duration === undefined) {
				throw new DomainError("Trial licenses require trialDurationMinutes");
			}
			validateInteger(duration, "trialDurationMinutes", 1);
			drafts.trial = { durationMinutes: duration };
			return {
				expiresAt: null,
				trialDurationMinutes: duration,
				trialStartedAt: typeChanged ? new Date() : current.trialStartedAt,
				typeDrafts: drafts,
			};
		}
		if (targetType === "lifetime") drafts.lifetime ??= {};
		else drafts.metered ??= { meterNames: [] };
		return {
			expiresAt: null,
			trialDurationMinutes: 0,
			trialStartedAt: null,
			typeDrafts: drafts,
		};
	}

	private withCurrentDraft(
		license: License,
		meterNames: string[],
	): LicenseTypeDrafts {
		const drafts = structuredClone(license.typeDrafts);
		switch (license.type) {
			case "subscription":
				drafts.subscription = {
					expiresAt: license.expiresAt?.toISOString() ?? null,
				};
				break;
			case "trial":
				drafts.trial = { durationMinutes: license.trialDurationMinutes };
				break;
			case "metered":
				drafts.metered = { meterNames: [...meterNames].sort() };
				break;
			case "lifetime":
				drafts.lifetime = {};
				break;
		}
		return drafts;
	}

	private validateMeters(meters: CreateMeterInput[]): NewLicenseMeter[] {
		const names = new Set<string>();
		return meters.map((meter) => {
			const name = this.meterName(meter.name);
			if (names.has(name)) throw new ConflictError(`Duplicate meter ${name}`);
			names.add(name);
			validateInteger(meter.balance, "meter balance");
			return {
				name,
				balance: meter.balance,
				reason: this.reason(meter.reason),
			};
		});
	}

	private meterName(value: string): string {
		const name = value.trim();
		if (!name || name.length > 128) {
			throw new DomainError(
				"Meter name must contain between 1 and 128 characters",
			);
		}
		return name;
	}

	private deviceId(value: string): string {
		const deviceId = value.trim();
		if (!deviceId || deviceId.length > 128) {
			throw new DomainError(
				"deviceId must contain between 1 and 128 characters",
			);
		}
		return deviceId;
	}

	private reason(value: string): string {
		const reason = value.trim();
		if (!reason || reason.length > 500) {
			throw new DomainError("reason must contain between 1 and 500 characters");
		}
		return reason;
	}

	private async requireLicense(id: string): Promise<License> {
		const license = await this.licenseRepo.findById(id);
		if (!license) throw new NotFoundError("License", "LICENSE_INVALID");
		return license;
	}

	private async updateMeterDraft(license: License): Promise<void> {
		const names = (await this.meterRepo.listMeters(license.id, false)).map(
			(meter) => meter.name,
		);
		await this.licenseRepo.updateMeterDraft(license.id, names);
	}

	private async captureLicenseUpdate(
		license: License,
		action: string,
		details: JsonObject = {},
	): Promise<void> {
		await this.capture({
			type: "license.updated",
			source: "operator",
			licenseId: license.id,
			customerId: license.customerId,
			keyPrefix: license.keyPrefix,
			details: { action, ...details },
		});
	}

	private async capture(event: NewActivityEvent): Promise<void> {
		try {
			await this.activity.capture(event);
		} catch {}
	}
}
