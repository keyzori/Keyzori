import type { RegisteredDevice } from "../entities";
import type { LicenseWithAllowlists } from "./ILicenseRepository";

export interface LicenseDeviceUsage {
	uniqueIps: number;
	uniqueDevices: number;
	ipRegistered: boolean;
	deviceRegistered: boolean;
}

export interface IDeviceRepository {
	withLicenseRegistrationLock<T>(
		licenseId: string,
		operation: (repository: IDeviceRepository) => Promise<T>,
	): Promise<T>;
	findLicenseAdmissionPolicy(
		licenseId: string,
	): Promise<LicenseWithAllowlists | null>;
	incrementLicenseSessionRevision(licenseId: string): Promise<number | null>;
	startTrialIfUnset(licenseId: string, startedAt: Date): Promise<Date | null>;
	findRegisteredDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice | null>;
	registerDevice(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<RegisteredDevice>;
	touchDevice(id: string, seenAt: Date): Promise<void>;
	getLicenseDeviceUsage(
		licenseId: string,
		ip: string,
		deviceId: string,
	): Promise<LicenseDeviceUsage>;
	removeRegisteredDevice(
		licenseId: string,
		registeredDeviceId: string,
	): Promise<boolean>;
	removeRegistrationsByIp(licenseId: string, ip: string): Promise<number>;
	removeRegistrationsByDevice(
		licenseId: string,
		deviceId: string,
	): Promise<number>;
	resetRegisteredDevices(licenseId: string): Promise<number>;
}
