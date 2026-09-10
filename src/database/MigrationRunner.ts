import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { SQL } from "bun";
import type { Database } from "./Database.ts";

const journalSchema = "keyzori_migrations";
export class MigrationRunner {
	constructor(
		private readonly database: Database,
		private readonly root: string,
	) {}
	async run(plugins: { name: string; directory: string }[]) {
		return this.execute(plugins, false);
	}
	async verify(plugins: { name: string; directory: string }[]) {
		return this.execute(plugins, true);
	}
	private async execute(
		plugins: { name: string; directory: string }[],
		verifyOnly: boolean,
	) {
		const client = await this.database.sql.reserve({
			signal: AbortSignal.timeout(15000),
		});
		try {
			await client`SET lock_timeout = '15s'`;
			await client`SELECT pg_advisory_lock(728491204)`;
			const [state] = await client<
				{ identity: string | null; journal: string | null }[]
			>`SELECT to_regclass('public.keyzori_application')::text AS identity, to_regclass('keyzori_migrations.core')::text AS journal`;
			if (!state?.identity) {
				const tables =
					await client`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'keyzori_migrations') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r', 'p') LIMIT 1`;
				if (tables.length)
					throw new Error(
						"A fresh database is required. Existing data was not changed.",
					);
			} else if (!state.journal)
				throw new Error(
					"Application identity exists without its migration journal.",
				);
			await this.apply(
				client,
				"core",
				join(this.root, "migrations"),
				verifyOnly,
			);
			for (const plugin of plugins) {
				const directory = join(plugin.directory, "migrations");
				if (
					existsSync(join(plugin.directory, "drizzle.config.ts")) &&
					!existsSync(directory)
				)
					throw new Error(`Plugin ${plugin.name} migrations are missing.`);
				if (existsSync(directory))
					await this.apply(
						client,
						`plugin_${plugin.name.replaceAll("-", "_")}`,
						directory,
						verifyOnly,
					);
			}
		} finally {
			try {
				await client`SELECT pg_advisory_unlock(728491204)`;
				await client`RESET lock_timeout`;
			} finally {
				client.release();
			}
		}
	}
	private async apply(
		client: SQL,
		table: string,
		directory: string,
		verifyOnly: boolean,
	) {
		const local = readMigrationFiles({ migrationsFolder: directory });
		if (!local.length) throw new Error(`No migrations found for ${table}.`);
		const [exists] = await client<
			{ name: string | null }[]
		>`SELECT to_regclass(${`${journalSchema}.${table}`})::text AS name`;
		let appliedCount = 0;
		if (exists?.name) {
			const applied = await client.unsafe<{ name: string; hash: string }[]>(
				`SELECT name, hash FROM "${journalSchema}"."${table}"`,
			);
			appliedCount = applied.length;
			for (const migration of applied) {
				if (
					local.find((item) => item.name === migration.name)?.hash !==
					migration.hash
				)
					throw new Error(`Missing or modified migration in ${table}.`);
			}
		}
		if (verifyOnly) {
			if (appliedCount !== local.length)
				throw new Error(
					`Pending migrations in ${table}. Run the migrate command before serving.`,
				);
			return;
		}
		await migrate(drizzle({ client }), {
			migrationsFolder: directory,
			migrationsSchema: journalSchema,
			migrationsTable: table,
		});
	}
}
