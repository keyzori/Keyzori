import type {
	DeviceAllowlistEntry,
	IpAllowlistEntry,
	License,
	NewLicense,
	NewLicenseMeter,
	RevealedLicense,
} from "../entities";

export type LicenseWithAllowlists = License & {
	allowedIps: IpAllowlistEntry[];
	allowedDevices: DeviceAllowlistEntry[];
};

export type LicenseUpdate = Partial<
	Pick<
		License,
		| "customerId"
		| "type"
		| "maxIps"
		| "maxDevices"
		| "maxSessions"
		| "trialDurationMinutes"
		| "trialStartedAt"
		| "metadata"
		| "expiresAt"
		| "typeDrafts"
		| "manualRevokedAt"
		| "manualRevocationReason"
	>
>;

export interface LicenseUpdateOptions {
	confirmStripeUnlink?: boolean;
	expectedUpdatedAt?: Date;
	manualExpiresAtUpdate?: boolean;
	newMeters?: NewLicenseMeter[];
}

export interface ILicenseRepository {
	create(data: NewLicense): Promise<RevealedLicense>;
	findById(id: string): Promise<License | null>;
	findByIdWithAllowlists(id: string): Promise<LicenseWithAllowlists | null>;
	findAll(): Promise<License[]>;
	update(
		id: string,
		data: LicenseUpdate,
		options?: LicenseUpdateOptions,
	): Promise<License>;
	delete(id: string): Promise<void>;
	findByLicenseKeyWithAllowlists(
		licenseKey: string,
	): Promise<LicenseWithAllowlists | null>;
	rotateKey(
		id: string,
		licenseKey: string,
		expectedUpdatedAt?: Date,
	): Promise<RevealedLicense>;
	incrementSessionRevision(id: string): Promise<License>;
	updateWithSessionInvalidation(
		id: string,
		data: LicenseUpdate,
	): Promise<License>;
	updateMeterDraft(id: string, meterNames: string[]): Promise<License>;
	startTrialIfUnset(id: string, startedAt: Date): Promise<License>;
}
