import type { UpdateCustomerInput } from "../../application/services/AdminService";
import type { JsonObject } from "../../domain/entities";
import type { Command } from "commander";
import type { AdminOperations } from "../AdminOperations";
import { runCommand } from "../commandError";
import { printJson } from "../output";
import { parseMetadata, requireValue } from "../parsers";

interface CreateCustomerOptions {
	email: string;
	name: string;
	metadata?: JsonObject;
}

interface UpdateCustomerOptions {
	email?: string;
	name?: string;
	metadata?: JsonObject;
}

export function registerCustomerCommands(
	program: Command,
	getService: () => AdminOperations,
): void {
	const customers = program
		.command("customers")
		.description("Manage license customers");

	customers
		.command("create")
		.description("Create a customer")
		.requiredOption("--email <email>", "Customer email")
		.requiredOption("--name <name>", "Customer name")
		.option("--metadata <json>", "Customer metadata JSON object", parseMetadata)
		.action(async (options: CreateCustomerOptions) => {
			await runCommand("Failed to create customer", async () => {
				const email = requireValue(options.email, "email");
				const name = requireValue(options.name, "name");
				printJson(
					await getService().createCustomer(
						email,
						name,
						options.metadata ?? {},
					),
				);
			});
		});

	customers
		.command("list")
		.description("List customers")
		.action(async () => {
			await runCommand("Failed to list customers", async () => {
				printJson(await getService().listCustomers());
			});
		});

	customers
		.command("get")
		.description("Get a customer")
		.argument("<customer-id>", "Customer ID")
		.action(async (customerId: string) => {
			await runCommand("Failed to get customer", async () => {
				printJson(
					await getService().getCustomer(
						requireValue(customerId, "customerId"),
					),
				);
			});
		});

	customers
		.command("update")
		.description("Update a customer")
		.argument("<customer-id>", "Customer ID")
		.option("--email <email>", "Customer email")
		.option("--name <name>", "Customer name")
		.option(
			"--metadata <json>",
			"Replacement metadata JSON object",
			parseMetadata,
		)
		.action(async (customerId: string, options: UpdateCustomerOptions) => {
			await runCommand("Failed to update customer", async () => {
				const input: UpdateCustomerInput = {};
				if (options.email !== undefined) {
					input.email = requireValue(options.email, "email");
				}
				if (options.name !== undefined) {
					input.name = requireValue(options.name, "name");
				}
				if (options.metadata !== undefined) input.metadata = options.metadata;
				printJson(
					await getService().updateCustomer(
						requireValue(customerId, "customerId"),
						input,
					),
				);
			});
		});

	customers
		.command("delete")
		.description("Delete a customer and their licenses")
		.argument("<customer-id>", "Customer ID")
		.action(async (customerId: string) => {
			await runCommand("Failed to delete customer", async () => {
				const id = requireValue(customerId, "customerId");
				await getService().deleteCustomer(id);
				printJson({ deleted: true, customerId: id });
			});
		});
}
