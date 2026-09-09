import type { AdminService } from "../application/services/AdminService";

/** The intentionally small service surface exposed to the local operator CLI. */
export interface AdminOperations {
	createCustomer: AdminService["createCustomer"];
	listCustomers: AdminService["listCustomers"];
	getCustomer: AdminService["getCustomer"];
	updateCustomer: AdminService["updateCustomer"];
	deleteCustomer: AdminService["deleteCustomer"];
	createLicense: AdminService["createLicense"];
	listLicenses: AdminService["listLicenses"];
	getLicense: AdminService["getLicense"];
	updateLicense: AdminService["updateLicense"];
	renewSubscription: AdminService["renewSubscription"];
	deleteLicense: AdminService["deleteLicense"];
	revokeLicense: AdminService["revokeLicense"];
	restoreLicense: AdminService["restoreLicense"];
	rotateLicenseKey: AdminService["rotateLicenseKey"];
	getLicenseAccess: AdminService["getLicenseAccess"];
	allowLicenseIp: AdminService["allowLicenseIp"];
	removeLicenseAllowedIp: AdminService["removeLicenseAllowedIp"];
	allowLicenseDevice: AdminService["allowLicenseDevice"];
	removeLicenseAllowedDevice: AdminService["removeLicenseAllowedDevice"];
	removeRegisteredIp: AdminService["removeRegisteredIp"];
	removeRegisteredDevice: AdminService["removeRegisteredDevice"];
	resetRegisteredDevices: AdminService["resetRegisteredDevices"];
	terminateLicenseSessions: AdminService["terminateLicenseSessions"];
	listLicenseMeters: AdminService["listLicenseMeters"];
	createLicenseMeter: AdminService["createLicenseMeter"];
	archiveLicenseMeter: AdminService["archiveLicenseMeter"];
	topUpLicenseMeter: AdminService["topUpLicenseMeter"];
	adjustLicenseMeter: AdminService["adjustLicenseMeter"];
	listLicenseUsageLedger: AdminService["listLicenseUsageLedger"];
}
