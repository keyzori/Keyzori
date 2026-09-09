import type { Command } from "commander";
import type { AdminOperations } from "../AdminOperations";
import { runCommand } from "../commandError";
import { printJson } from "../output";
import {
	parseNonNegativeInteger,
	parseNonZeroInteger,
	parsePositiveInteger,
	parseReason,
	requireValue,
} from "../parsers";

interface MeterOptions {
	name: string;
}

export function registerMeterCommands(
	licenses: Command,
	getService: () => AdminOperations,
): void {
	const meters = licenses
		.command("meters")
		.description("Manage immutable named usage meters");

	meters
		.command("list")
		.description("List meters")
		.argument("<license-id>", "License ID")
		.option("--include-archived", "Include archived meters")
		.action(
			async (licenseId: string, options: { includeArchived?: boolean }) => {
				await runCommand("Failed to list meters", async () => {
					printJson(
						await getService().listLicenseMeters(
							requireValue(licenseId, "licenseId"),
							options.includeArchived ?? false,
						),
					);
				});
			},
		);

	meters
		.command("create")
		.description("Create a named meter")
		.argument("<license-id>", "License ID")
		.requiredOption("--name <name>", "Immutable meter name")
		.requiredOption(
			"--balance <units>",
			"Initial non-negative balance",
			parseNonNegativeInteger,
		)
		.requiredOption("--reason <reason>", "Operator reason", parseReason)
		.action(
			async (
				licenseId: string,
				options: MeterOptions & { balance: number; reason: string },
			) => {
				await runCommand("Failed to create meter", async () => {
					printJson(
						await getService().createLicenseMeter(
							requireValue(licenseId, "licenseId"),
							{
								name: requireValue(options.name, "meter name"),
								balance: options.balance,
								reason: options.reason,
							},
						),
					);
				});
			},
		);

	meters
		.command("archive")
		.description("Archive a meter without renaming or deleting its ledger")
		.argument("<license-id>", "License ID")
		.requiredOption("--name <name>", "Meter name")
		.requiredOption("--reason <reason>", "Operator reason", parseReason)
		.action(
			async (licenseId: string, options: MeterOptions & { reason: string }) => {
				await runCommand("Failed to archive meter", async () => {
					printJson(
						await getService().archiveLicenseMeter(
							requireValue(licenseId, "licenseId"),
							requireValue(options.name, "meter name"),
							options.reason,
						),
					);
				});
			},
		);

	meters
		.command("top-up")
		.description("Add units with an operator reason and ledger entry")
		.argument("<license-id>", "License ID")
		.requiredOption("--name <name>", "Meter name")
		.requiredOption("--units <units>", "Positive units", parsePositiveInteger)
		.requiredOption("--reason <reason>", "Operator reason", parseReason)
		.action(
			async (
				licenseId: string,
				options: MeterOptions & { units: number; reason: string },
			) => {
				await runCommand("Failed to top up meter", async () => {
					printJson(
						await getService().topUpLicenseMeter(
							requireValue(licenseId, "licenseId"),
							requireValue(options.name, "meter name"),
							options.units,
							options.reason,
						),
					);
				});
			},
		);

	meters
		.command("adjust")
		.description("Adjust a meter by a non-zero signed amount")
		.argument("<license-id>", "License ID")
		.requiredOption("--name <name>", "Meter name")
		.requiredOption("--delta <units>", "Signed adjustment", parseNonZeroInteger)
		.requiredOption("--reason <reason>", "Operator reason", parseReason)
		.action(
			async (
				licenseId: string,
				options: MeterOptions & { delta: number; reason: string },
			) => {
				await runCommand("Failed to adjust meter", async () => {
					printJson(
						await getService().adjustLicenseMeter(
							requireValue(licenseId, "licenseId"),
							requireValue(options.name, "meter name"),
							options.delta,
							options.reason,
						),
					);
				});
			},
		);

	meters
		.command("ledger")
		.description("List durable usage and adjustment ledger entries")
		.argument("<license-id>", "License ID")
		.option("--meter <name>", "Filter by meter name")
		.action(async (licenseId: string, options: { meter?: string }) => {
			await runCommand("Failed to list meter ledger", async () => {
				printJson(
					await getService().listLicenseUsageLedger(
						requireValue(licenseId, "licenseId"),
						options.meter === undefined
							? undefined
							: requireValue(options.meter, "meter name"),
					),
				);
			});
		});
}
