import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import { jsonInput, segment, type Output } from "./input.ts";

export class AccessCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("access")
			.description("Manage policy, allowlists, devices, and IPs");
		command
			.command("get <licenseId>")
			.action(async (id: string) =>
				this.output(
					await this.client.request("GET", `/admin/access/${segment(id)}`),
				),
			);
		command
			.command("policy <licenseId> <json>")
			.action(async (id: string, json: string) =>
				this.output(
					await this.client.request(
						"PATCH",
						`/admin/access/${segment(id)}`,
						await jsonInput(json),
					),
				),
			);
		command
			.command("allowlists <licenseId> <json>")
			.action(async (id: string, json: string) =>
				this.output(
					await this.client.request(
						"PUT",
						`/admin/access/${segment(id)}/allowlists`,
						await jsonInput(json),
					),
				),
			);
		for (const kind of ["devices", "ips"]) {
			const resource = command.command(kind);
			resource
				.command("list <licenseId>")
				.option("--limit <n>", "Page size", "50")
				.option("--offset <n>", "Page offset", "0")
				.action(async (id: string, query) =>
					this.output(
						await this.client.request(
							"GET",
							`/admin/access/${segment(id)}/${kind}`,
							undefined,
							query,
						),
					),
				);
			for (const action of ["block", "unblock", "remove"])
				resource
					.command(`${action} <licenseId> <registrationId>`)
					.action(async (id: string, registration: string) =>
						this.output(
							await this.client.request(
								action === "remove" ? "DELETE" : "PATCH",
								`/admin/access/${segment(id)}/${kind}/${segment(registration)}`,
								action === "remove"
									? undefined
									: { blocked: action === "block" },
							),
						),
					);
		}
	}
}
