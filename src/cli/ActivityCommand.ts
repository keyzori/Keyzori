import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import type { Output } from "./input.ts";

export class ActivityCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("activity")
			.description("Inspect, filter, and prune activity");
		for (const name of ["list", "statistics"])
			command
				.command(name)
				.option("--licenseId <id>")
				.option("--customerId <id>")
				.option("--action <action>")
				.option("--source <source>")
				.option("--from <ISO>")
				.option("--to <ISO>")
				.option("--limit <n>", "Page size", "50")
				.option("--offset <n>", "Page offset", "0")
				.action(async (query) =>
					this.output(
						await this.client.request(
							"GET",
							`/admin/activity${name === "statistics" ? "/statistics" : ""}`,
							undefined,
							query,
						),
					),
				);
		command
			.command("prune")
			.action(async () =>
				this.output(
					await this.client.request("POST", "/admin/activity/prune", {}),
				),
			);
	}
}
