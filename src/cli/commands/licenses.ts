import type {
	CreateLicenseInput,
	CreateMeterInput,
	UpdateLicenseInput,
} from "../../application/services/AdminService";
import type { JsonObject, LicenseType } from "../../domain/entities";
import type { Command } from "commander";
import type { AdminOperations } from "../AdminOperations";
import { runCommand } from "../commandError";
import { printJson } from "../output";
import {
	collectMeter,
	type CollectedMeter,
	parseIsoDate,
	parseLicenseType,
	parseMetadata,
	parseNonNegativeInteger,
	parsePositiveInteger,
	parseReason,
	requireValue,
} from "../parsers";
import { registerAccessCommands } from "./licenseAccess";
import { registerMeterCommands } from "./meters";

interface CommonLicenseOptions {
	customerId?: string;
	type?: LicenseType;
	maxIps?: number;
	maxDevices?: number;
	maxSessions?: number;
	trialDurationMinutes?: number;
	metadata?: JsonObject;
	expiresAt?: string;
	meter: CollectedMeter[];
	meterReason?: string;
}

interface CreateLicenseOptions extends CommonLicenseOptions {
	customerId: string;
	type: LicenseType;
}

interface UpdateLicenseOptions extends CommonLicenseOptions {
	clearExpiresAt?: boolean;
	unlinkStripe?: boolean;
}

function addLicenseOptions(command: Command, create: boolean): Command {
	if (create) {
		command.requiredOption("--customer-id <id>", "Customer ID");
	} else {
		command.option("--customer-id <id>", "Move to another customer");
	}
	command
		.option(
			"--type <type>",
			"License type: lifetime, subscription, metered, or trial",
			parseLicenseType,
			...(create ? (["lifetime"] as const) : []),
		)
		.option(
			"--max-ips <count>",
			"Registered IP slots; 0 is unlimited",
			parseNonNegativeInteger,
		)
		.option(
			"--max-devices <count>",
			"Registered device slots; 0 is unlimited",
			parseNonNegativeInteger,
		)
		.option(
			"--max-sessions <count>",
			"Concurrent sessions; 0 is unlimited",
			parseNonNegativeInteger,
		)
		.option(
			"--trial-duration-minutes <minutes>",
			"Positive trial duration",
			parsePositiveInteger,
		)
		.option(
			"--metadata <json>",
			"Replacement metadata JSON object",
			parseMetadata,
		)
		.option(
			"--expires-at <date>",
			"Subscription expiration (ISO 8601)",
			parseIsoDate,
		)
		.option(
			"--meter <name=balance>",
			"Named meter and starting balance; repeatable",
			collectMeter,
			[],
		)
		.option(
			"--meter-reason <reason>",
			"Operator reason applied to newly created meter ledger entries",
			parseReason,
		);
	return command;
}

function meters(options: CommonLicenseOptions): CreateMeterInput[] {
	if (options.meter.length === 0) return [];
	if (!options.meterReason) {
		throw new Error("--meter-reason is required when --meter is provided.");
	}
	return options.meter.map((meter) => ({
		...meter,
		reason: options.meterReason as string,
	}));
}

function createInput(options: CreateLicenseOptions): CreateLicenseInput {
	return {
		customerId: requireValue(options.customerId, "customerId"),
		type: options.type,
		...(options.maxIps === undefined ? {} : { maxIps: options.maxIps }),
		...(options.maxDevices === undefined
			? {}
			: { maxDevices: options.maxDevices }),
		...(options.maxSessions === undefined
			? {}
			: { maxSessions: options.maxSessions }),
		...(options.trialDurationMinutes === undefined
			? {}
			: { trialDurationMinutes: options.trialDurationMinutes }),
		...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		...(options.expiresAt === undefined
			? {}
			: { expiresAt: options.expiresAt }),
		...(options.meter.length === 0 ? {} : { meters: meters(options) }),
	};
}

function updateInput(options: UpdateLicenseOptions): UpdateLicenseInput {
	if (options.clearExpiresAt && options.expiresAt !== undefined) {
		throw new Error(
			"--expires-at and --clear-expires-at cannot be used together.",
		);
	}
	return {
		...(options.customerId === undefined
			? {}
			: { customerId: requireValue(options.customerId, "customerId") }),
		...(options.type === undefined ? {} : { type: options.type }),
		...(options.maxIps === undefined ? {} : { maxIps: options.maxIps }),
		...(options.maxDevices === undefined
			? {}
			: { maxDevices: options.maxDevices }),
		...(options.maxSessions === undefined
			? {}
			: { maxSessions: options.maxSessions }),
		...(options.trialDurationMinutes === undefined
			? {}
			: { trialDurationMinutes: options.trialDurationMinutes }),
		...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		...(options.clearExpiresAt
			? { expiresAt: null }
			: options.expiresAt === undefined
				? {}
				: { expiresAt: options.expiresAt }),
		...(options.meter.length === 0 ? {} : { meters: meters(options) }),
		...(options.unlinkStripe ? { unlinkStripe: true } : {}),
	};
}

export function registerLicenseCommands(
	program: Command,
	getService: () => AdminOperations,
): void {
	const licenses = program.command("licenses").description("Manage licenses");

	addLicenseOptions(
		licenses.command("create").description("Create a license"),
		true,
	).action(async (options: CreateLicenseOptions) => {
		await runCommand("Failed to create license", async () => {
			printJson(await getService().createLicense(createInput(options)), true);
		});
	});

	licenses
		.command("list")
		.description("List licenses using key prefixes only")
		.action(async () => {
			await runCommand("Failed to list licenses", async () => {
				printJson(await getService().listLicenses());
			});
		});

	licenses
		.command("get")
		.description("Get a license using its key prefix only")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to get license", async () => {
				printJson(
					await getService().getLicense(requireValue(licenseId, "licenseId")),
				);
			});
		});

	addLicenseOptions(
		licenses
			.command("update")
			.description("Update a license")
			.argument("<license-id>", "License ID")
			.option("--clear-expires-at", "Clear the active subscription expiration")
			.option(
				"--unlink-stripe",
				"Confirm unlinking Stripe when changing away from subscription",
			),
		false,
	).action(async (licenseId: string, options: UpdateLicenseOptions) => {
		await runCommand("Failed to update license", async () => {
			printJson(
				await getService().updateLicense(
					requireValue(licenseId, "licenseId"),
					updateInput(options),
				),
			);
		});
	});

	licenses
		.command("delete")
		.description("Delete a license")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to delete license", async () => {
				const id = requireValue(licenseId, "licenseId");
				await getService().deleteLicense(id);
				printJson({ deleted: true, licenseId: id });
			});
		});

	licenses
		.command("renew")
		.description("Renew a subscription license")
		.argument("<license-id>", "License ID")
		.requiredOption(
			"--expires-at <date>",
			"New subscription expiration (ISO 8601)",
			parseIsoDate,
		)
		.action(async (licenseId: string, options: { expiresAt: string }) => {
			await runCommand("Failed to renew license", async () => {
				printJson(
					await getService().renewSubscription(
						requireValue(licenseId, "licenseId"),
						options.expiresAt,
					),
				);
			});
		});

	licenses
		.command("revoke")
		.description("Manually revoke a license")
		.argument("<license-id>", "License ID")
		.option(
			"--reason <reason>",
			"Operator reason",
			parseReason,
			"Revoked by operator",
		)
		.action(async (licenseId: string, options: { reason: string }) => {
			await runCommand("Failed to revoke license", async () => {
				printJson(
					await getService().revokeLicense(
						requireValue(licenseId, "licenseId"),
						options.reason,
					),
				);
			});
		});

	licenses
		.command("restore")
		.description("Clear a manual license revocation")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to restore license", async () => {
				printJson(
					await getService().restoreLicense(
						requireValue(licenseId, "licenseId"),
					),
				);
			});
		});

	licenses
		.command("rotate")
		.description("Rotate a license key and reveal it once")
		.argument("<license-id>", "License ID")
		.action(async (licenseId: string) => {
			await runCommand("Failed to rotate license key", async () => {
				printJson(
					await getService().rotateLicenseKey(
						requireValue(licenseId, "licenseId"),
					),
					true,
				);
			});
		});

	registerAccessCommands(licenses, getService);
	registerMeterCommands(licenses, getService);
}
