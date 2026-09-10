import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import { jsonInput, segment, type Output } from "./input.ts";

export class CustomersCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("customers")
			.description("Manage customers");
		command
			.command("list")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (query) =>
				this.output(
					await this.client.request(
						"GET",
						"/admin/customers",
						undefined,
						query,
					),
				),
			);
		command
			.command("get <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request("GET", `/admin/customers/${segment(id)}`),
				),
			);
		command
			.command("create <json>")
			.description("Create from JSON or @file.json")
			.action(async (json: string) =>
				this.output(
					await this.client.request(
						"POST",
						"/admin/customers",
						await jsonInput(json),
					),
				),
			);
		command
			.command("update <id> <json>")
			.action(async (id: string, json: string) =>
				this.output(
					await this.client.request(
						"PUT",
						`/admin/customers/${segment(id)}`,
						await jsonInput(json),
					),
				),
			);
		command
			.command("delete <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"DELETE",
						`/admin/customers/${segment(id)}`,
					),
				),
			);
	}
}
