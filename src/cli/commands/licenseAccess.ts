import type { Command } from "commander";
import type { AdminOperations } from "../AdminOperations";
import { runCommand } from "../commandError";
import { printJson } from "../output";
import { requireValue } from "../parsers";

export function registerAccessCommands(
	licenses: Command,
	getService: () => AdminOperations,
): void {
	const access = licenses
		.command("access")
		.description("Manage allowlists, registered slots, and sessions");

	access
		.command("show")
		.description("Show exact protected access records")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to get license access", async () => {
				printJson(
					await getService().getLicenseAccess(
						requireValue(licenseId, "licenseId"),
					),
				);
			});
		});

	access
		.command("allow-ip")
		.description("Add an IP address to the explicit allowlist")
		.argument("<license-id>", "License ID")
		.argument("<ip>", "IPv4 or IPv6 address")
		.action(async (licenseId: string, ip: string) => {
			await runCommand("Failed to allow IP", async () => {
				printJson(
					await getService().allowLicenseIp(
						requireValue(licenseId, "licenseId"),
						requireValue(ip, "ip"),
					),
				);
			});
		});

	access
		.command("remove-allowed-ip")
		.description("Remove an IP address from the explicit allowlist")
		.argument("<license-id>", "License ID")
		.argument("<ip>", "IPv4 or IPv6 address")
		.action(async (licenseId: string, ip: string) => {
			await runCommand("Failed to remove allowed IP", async () => {
				const id = requireValue(licenseId, "licenseId");
				const value = requireValue(ip, "ip");
				const removed = await getService().removeLicenseAllowedIp(id, value);
				printJson({ licenseId: id, ip: value, removed });
			});
		});

	access
		.command("allow-device")
		.description("Add a device ID to the explicit allowlist")
		.argument("<license-id>", "License ID")
		.argument("<device-id>", "Device ID")
		.action(async (licenseId: string, deviceId: string) => {
			await runCommand("Failed to allow device", async () => {
				printJson(
					await getService().allowLicenseDevice(
						requireValue(licenseId, "licenseId"),
						requireValue(deviceId, "deviceId"),
					),
				);
			});
		});

	access
		.command("remove-allowed-device")
		.description("Remove a device ID from the explicit allowlist")
		.argument("<license-id>", "License ID")
		.argument("<device-id>", "Device ID")
		.action(async (licenseId: string, deviceId: string) => {
			await runCommand("Failed to remove allowed device", async () => {
				const id = requireValue(licenseId, "licenseId");
				const value = requireValue(deviceId, "deviceId");
				const removed = await getService().removeLicenseAllowedDevice(
					id,
					value,
				);
				printJson({ licenseId: id, deviceId: value, removed });
			});
		});

	access
		.command("remove-registered-ip")
		.description("Free registered slots for an IP address")
		.argument("<license-id>", "License ID")
		.argument("<ip>", "IPv4 or IPv6 address")
		.action(async (licenseId: string, ip: string) => {
			await runCommand("Failed to remove registered IP", async () => {
				const id = requireValue(licenseId, "licenseId");
				const value = requireValue(ip, "ip");
				const removed = await getService().removeRegisteredIp(id, value);
				printJson({ licenseId: id, ip: value, removed });
			});
		});

	access
		.command("remove-registered-device")
		.description("Free registered slots for a device ID")
		.argument("<license-id>", "License ID")
		.argument("<device-id>", "Device ID")
		.action(async (licenseId: string, deviceId: string) => {
			await runCommand("Failed to remove registered device", async () => {
				const id = requireValue(licenseId, "licenseId");
				const value = requireValue(deviceId, "deviceId");
				const removed = await getService().removeRegisteredDevice(id, value);
				printJson({ licenseId: id, deviceId: value, removed });
			});
		});

	access
		.command("reset-registered-devices")
		.description("Clear every registered device/IP slot and active session")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to reset registered devices", async () => {
				const id = requireValue(licenseId, "licenseId");
				const removed = await getService().resetRegisteredDevices(id);
				printJson({ licenseId: id, removed });
			});
		});

	access
		.command("terminate-sessions")
		.description("Terminate every active session for a license")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to terminate sessions", async () => {
				const id = requireValue(licenseId, "licenseId");
				const removed = await getService().terminateLicenseSessions(id);
				printJson({ licenseId: id, removed });
			});
		});
}
