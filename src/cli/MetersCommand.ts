import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import { jsonInput, segment, type Output } from "./input.ts";

export class MetersCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("meters")
			.description("Manage meter budgets and inspect usage");
		command
			.command("list <licenseId>")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (licenseId: string, query) =>
				this.output(
					await this.client.request("GET", "/admin/meters", undefined, {
						...query,
						licenseId,
					}),
				),
			);
		command
			.command("get <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request("GET", `/admin/meters/${segment(id)}`),
				),
			);
		command
			.command("create <json>")
			.action(async (json: string) =>
				this.output(
					await this.client.request(
						"POST",
						"/admin/meters",
						await jsonInput(json),
					),
				),
			);
		command
			.command("update <id> <json>")
			.action(async (id: string, json: string) =>
				this.output(
					await this.client.request(
						"PATCH",
						`/admin/meters/${segment(id)}`,
						await jsonInput(json),
					),
				),
			);
		program
			.command("usage <licenseId>")
			.option("--meterId <id>")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (licenseId: string, query) =>
				this.output(
					await this.client.request("GET", "/admin/usage", undefined, {
						...query,
						licenseId,
					}),
				),
			);
	}
}
