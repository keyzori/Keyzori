import type {
	DeviceAllowlistEntry,
	IpAllowlistEntry,
	RegisteredDevice,
} from "../entities";

export interface AccessAttemptIdentifier {
	value: string;
	attemptCount: number;
	firstAttemptedAt: Date;
	lastAttemptedAt: Date;
}

export interface AccessRecords {
	allowedIps: IpAllowlistEntry[];
	allowedDevices: DeviceAllowlistEntry[];
	registeredDevices: RegisteredDevice[];
	attemptedIps: AccessAttemptIdentifier[];
	attemptedDevices: AccessAttemptIdentifier[];
}

export interface IAccessRepository {
	getAccessRecords(licenseId: string): Promise<AccessRecords>;
	addAllowedIp(licenseId: string, ip: string): Promise<IpAllowlistEntry>;
	removeAllowedIp(licenseId: string, ip: string): Promise<boolean>;
	addAllowedDevice(
		licenseId: string,
		deviceId: string,
	): Promise<DeviceAllowlistEntry>;
	removeAllowedDevice(licenseId: string, deviceId: string): Promise<boolean>;
}

export const noopAccessRepository: IAccessRepository = {
	getAccessRecords: async () => ({
		allowedIps: [],
		allowedDevices: [],
		registeredDevices: [],
		attemptedIps: [],
		attemptedDevices: [],
	}),
	addAllowedIp: async (licenseId, ip) => ({
		id: crypto.randomUUID(),
		licenseId,
		ip,
		createdAt: new Date(),
	}),
	removeAllowedIp: async () => false,
	addAllowedDevice: async (licenseId, deviceId) => ({
		id: crypto.randomUUID(),
		licenseId,
		deviceId,
		createdAt: new Date(),
	}),
	removeAllowedDevice: async () => false,
};
