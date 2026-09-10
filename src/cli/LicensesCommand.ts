import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import { jsonInput, segment, type Output } from "./input.ts";

export class LicensesCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("licenses")
			.description("Manage license types, keys, and renewal");
		command
			.command("list")
			.option("--customerId <id>")
			.option("--type <type>")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (query) =>
				this.output(
					await this.client.request("GET", "/admin/licenses", undefined, query),
				),
			);
		command
			.command("get <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request("GET", `/admin/licenses/${segment(id)}`),
				),
			);
		command
			.command("create <json>")
			.action(async (json: string) =>
				this.output(
					await this.client.request(
						"POST",
						"/admin/licenses",
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
						`/admin/licenses/${segment(id)}`,
						await jsonInput(json),
					),
				),
			);
		command
			.command("type <id> <json>")
			.action(async (id: string, json: string) =>
				this.output(
					await this.client.request(
						"PUT",
						`/admin/licenses/${segment(id)}/type`,
						await jsonInput(json),
					),
				),
			);
		command
			.command("renew <id> <expiresAt>")
			.action(async (id: string, expiresAt: string) =>
				this.output(
					await this.client.request(
						"POST",
						`/admin/licenses/${segment(id)}/renew`,
						{ expiresAt },
					),
				),
			);
		command
			.command("rotate <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"POST",
						`/admin/licenses/${segment(id)}/rotate`,
						{},
					),
				),
			);
		command
			.command("revoke <id>")
			.option("--reason <reason>")
			.action(async (id: string, options) =>
				this.output(
					await this.client.request(
						"POST",
						`/admin/licenses/${segment(id)}/revoke`,
						options,
					),
				),
			);
		command
			.command("restore <id>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"POST",
						`/admin/licenses/${segment(id)}/restore`,
						{},
					),
				),
			);
	}
}
