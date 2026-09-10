import type { Command } from "commander";
import type { AdminClient } from "../../src/cli/AdminClient.ts";
import { segment, type Output } from "../../src/cli/input.ts";

export default class StripeCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("stripe")
			.description("Manage the enabled billing plugin");
		command
			.command("links")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (query) =>
				this.output(
					await this.client.request(
						"GET",
						"/plugins/stripe/admin/links",
						undefined,
						query,
					),
				),
			);
		command
			.command("link <licenseId> <subscriptionId>")
			.action(async (licenseId: string, subscriptionId: string) =>
				this.output(
					await this.client.request("POST", "/plugins/stripe/admin/links", {
						licenseId,
						subscriptionId,
					}),
				),
			);
		command
			.command("unlink <licenseId>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"DELETE",
						`/plugins/stripe/admin/links/${segment(id)}`,
					),
				),
			);
		command
			.command("sync <licenseId>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"POST",
						`/plugins/stripe/admin/links/${segment(id)}/sync`,
						{},
					),
				),
			);
		command
			.command("events")
			.option("--state <state>")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (query) =>
				this.output(
					await this.client.request(
						"GET",
						"/plugins/stripe/admin/events",
						undefined,
						query,
					),
				),
			);
		command
			.command("retry <eventId>")
			.action(async (id: string) =>
				this.output(
					await this.client.request(
						"POST",
						`/plugins/stripe/admin/events/${segment(id)}/retry`,
						{},
					),
				),
			);
	}
}
