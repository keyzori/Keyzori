import { Command } from "commander";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Environment } from "../shared/Config.ts";
import { PluginLoader } from "../plugins/PluginLoader.ts";
import { AdminClient } from "./AdminClient.ts";
import { print, type Output } from "./input.ts";
import { CustomersCommand } from "./CustomersCommand.ts";
import { LicensesCommand } from "./LicensesCommand.ts";
import { AccessCommand } from "./AccessCommand.ts";
import { SessionsCommand } from "./SessionsCommand.ts";
import { MetersCommand } from "./MetersCommand.ts";
import { ActivityCommand } from "./ActivityCommand.ts";

export class Cli {
	constructor(
		private readonly env: Environment,
		private readonly root: string,
		private readonly output: Output = print,
	) {}
	async run(args: string[]) {
		const program = new Command()
			.name("keyzori admin")
			.description("HTTP administration. JSON arguments accept @file.json.")
			.exitOverride();
		const client = new AdminClient(this.env);
		for (const CommandClass of [
			CustomersCommand,
			LicensesCommand,
			AccessCommand,
			SessionsCommand,
			MetersCommand,
			ActivityCommand,
		])
			new CommandClass(client, this.output).register(program);
		const available = await new PluginLoader(
			join(this.root, "plugins"),
		).discover();
		const enabled = (this.env.KEYZORI_PLUGINS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.sort();
		if (new Set(enabled).size !== enabled.length)
			throw new Error("Duplicate enabled plugins.");
		for (const name of enabled) {
			if (!available.includes(name))
				throw new Error(`Enabled plugin ${name} is missing.`);
			const path = join(this.root, "plugins", name, "cli.ts");
			if (!existsSync(path)) continue;
			const module = await import(pathToFileURL(path).href);
			new module.default(client, this.output).register(program);
		}
		await program.parseAsync(args, { from: "user" });
	}
}
