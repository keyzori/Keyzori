import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { migrationAssets } from "./migrationAssets";
import type { Database } from "./Database";

export class MigrationService {
	constructor(private readonly database: Database) {}
	async run() {
		const connection = await this.database.client.reserve();
		try {
			await connection`select pg_advisory_lock(6284, 0)`;
			const [version] = await connection<
				{ version: string }[]
			>`select current_setting('server_version_num') as version`;
			if (!version || Number(version.version) < 170000)
				throw new Error("PostgreSQL 17 or later is required");
			const [state] = await connection<
				{ schema: boolean; journal: boolean }[]
			>`select to_regnamespace('drizzle') is not null as schema,
			to_regclass('drizzle.__drizzle_migrations') is not null as journal`;
			const rows = state?.journal
				? await connection<
						{ hash: string; created_at: string | number; name: string | null }[]
					>`select hash, created_at, name from drizzle.__drizzle_migrations order by created_at, id`
				: [];
			if (rows.length === 0) {
				const tables = await connection`
				select c.relname from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname not in ('pg_catalog', 'information_schema')
				and n.nspname not like 'pg_toast%'
				and n.nspname not like 'pg_temp%'
				and c.relkind in ('r', 'p', 'f', 'm')
				and c.oid <> coalesce(to_regclass('drizzle.__drizzle_migrations'), 0)
				limit 1`;
				if (tables.length)
					throw new Error(
						"A fresh database is required when v2 migration history is missing or empty. Existing data was not changed.",
					);
			}
			for (const [index, row] of rows.entries()) {
				const local = migrationAssets[index];
				if (
					!local ||
					local.hash !== row.hash ||
					local.folderMillis !== Number(row.created_at) ||
					local.name !== row.name
				)
					throw new Error(
						"Database migration history is modified or incompatible with this server",
					);
			}
			if (!state?.schema) await connection`create schema drizzle`;
			await connection`create table if not exists drizzle.__drizzle_migrations (
			id serial primary key, hash text not null, created_at bigint, name text,
			applied_at timestamp with time zone default now()
		)`;
			await drizzle({ client: connection }).transaction(async (tx) => {
				for (const migration of migrationAssets.slice(rows.length)) {
					for (const statement of migration.sql)
						await tx.execute(sql.raw(statement));
					await tx.execute(
						sql`insert into drizzle.__drizzle_migrations (hash, created_at, name) values (${migration.hash}, ${migration.folderMillis}, ${migration.name})`,
					);
				}
			});
		} finally {
			try {
				await connection`select pg_advisory_unlock(6284, 0)`;
			} finally {
				connection.release();
			}
		}
	}
}
