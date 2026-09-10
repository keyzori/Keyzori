import type { Command } from "commander";
import type { AdminClient } from "./AdminClient.ts";
import { segment, type Output } from "./input.ts";

export class SessionsCommand {
	constructor(
		private readonly client: AdminClient,
		private readonly output: Output,
	) {}
	register(program: Command) {
		const command = program
			.command("sessions")
			.description("Inspect and terminate runtime sessions");
		command
			.command("list <licenseId>")
			.option("--limit <n>", "Page size", "50")
			.option("--offset <n>", "Page offset", "0")
			.action(async (licenseId: string, query) =>
				this.output(
					await this.client.request("GET", "/admin/sessions", undefined, {
						...query,
						licenseId,
					}),
				),
			);
		command
			.command("terminate <licenseId> [sessionId]")
			.action(async (id: string, session?: string) =>
				this.output(
					await this.client.request(
						"DELETE",
						`/admin/sessions/${segment(id)}${session ? `/${segment(session)}` : ""}`,
					),
				),
			);
	}
}
