import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { migrationAssets, migrationFingerprint } from "./migrationAssets";
import type { Database } from "./Database";

export class MigrationError extends Error {
	constructor(
		readonly code:
			| "SCHEMA_INCOMPATIBLE"
			| "UNSUPPORTED_DATABASE_VERSION"
			| "MIGRATION_ROLE_REQUIRED",
		message: string,
	) {
		super(message);
		this.name = "MigrationError";
	}
}

export class MigrationService {
	constructor(private readonly database: Database) {}
	/** Refuses missing, pending, modified or newer history without changing the schema. */
	async verify() {
		using connection = await this.database.client.reserve({
			signal: AbortSignal.timeout(5000),
		});
		const [timeouts] = await connection<{ lock: string; statement: string }[]>`
			select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`;
		if (!timeouts) throw new Error("Database session settings are unavailable");
		let locked = false;
		try {
			await connection`select set_config('lock_timeout', '5s', false), set_config('statement_timeout', '5s', false)`;
			await connection`select pg_advisory_lock_shared(6284, 0)`;
			locked = true;
			const [state] = await connection<{ version: string; journal: boolean }[]>`
				select current_setting('server_version_num') as version,
				to_regclass('drizzle.__drizzle_migrations') is not null as journal`;
			if (!state || Number(state.version) < 170000)
				throw new MigrationError(
					"UNSUPPORTED_DATABASE_VERSION",
					"PostgreSQL 17 or later is required",
				);
			if (!state.journal)
				throw new MigrationError(
					"SCHEMA_INCOMPATIBLE",
					"Database migration history is missing; run the migration command first",
				);
			const rows = await connection<
				{ hash: string; created_at: string | number; name: string | null }[]
			>`
				select hash, created_at, name from drizzle.__drizzle_migrations order by created_at, id`;
			if (rows.length !== migrationAssets.length)
				throw new MigrationError(
					"SCHEMA_INCOMPATIBLE",
					"Database migration history is incompatible; run the matching migration command",
				);
			for (const [index, row] of rows.entries()) {
				const local = migrationAssets[index];
				if (
					!local ||
					local.hash !== row.hash ||
					local.folderMillis !== Number(row.created_at) ||
					local.name !== row.name
				)
					throw new MigrationError(
						"SCHEMA_INCOMPATIBLE",
						"Database migration history is modified or incompatible with this server",
					);
			}
			return { migrations: rows.length, fingerprint: migrationFingerprint };
		} finally {
			try {
				if (locked) await connection`select pg_advisory_unlock_shared(6284, 0)`;
			} finally {
				await connection`select set_config('lock_timeout', ${timeouts.lock}, false), set_config('statement_timeout', ${timeouts.statement}, false)`;
			}
		}
	}
	async run() {
		using connection = await this.database.client.reserve({
			signal: AbortSignal.timeout(5000),
		});
		const [timeouts] = await connection<{ lock: string; statement: string }[]>`
			select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`;
		if (!timeouts) throw new Error("Database session settings are unavailable");
		let locked = false;
		try {
			await connection`select set_config('lock_timeout', '10s', false), set_config('statement_timeout', '60s', false)`;
			await connection`select pg_advisory_lock(6284, 0)`;
			locked = true;
			const [version] = await connection<
				{ version: string }[]
			>`select current_setting('server_version_num') as version`;
			if (!version || Number(version.version) < 170000)
				throw new MigrationError(
					"UNSUPPORTED_DATABASE_VERSION",
					"PostgreSQL 17 or later is required",
				);
			const [authority] = await connection<{ permitted: boolean }[]>`
				select current_user <> 'keyzori_server'
				and has_schema_privilege(current_user, 'public', 'CREATE')
				and (to_regnamespace('drizzle') is null or has_schema_privilege(current_user, 'drizzle', 'CREATE')) as permitted`;
			if (!authority?.permitted)
				throw new MigrationError(
					"MIGRATION_ROLE_REQUIRED",
					"The explicit migration command requires a separate schema-owner credential",
				);
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
				const objects = await connection`
				select c.relname as name from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname not in ('pg_catalog', 'information_schema')
				and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
				and not (n.nspname = 'drizzle' and c.relname in ('__drizzle_migrations', '__drizzle_migrations_id_seq', '__drizzle_migrations_pkey'))
				union all select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
				where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
				union all select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
				where t.typtype in ('e', 'd') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
				limit 1`;
				if (objects.length)
					throw new MigrationError(
						"SCHEMA_INCOMPATIBLE",
						"A fresh database is required when migration history is missing or empty. Existing data was not changed.",
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
					throw new MigrationError(
						"SCHEMA_INCOMPATIBLE",
						"Database migration history is modified or incompatible with this server",
					);
			}
			await drizzle({ client: connection }).transaction(async (tx) => {
				// Journal creation, schema changes and history are committed together. A
				// terminated migrator cannot leave an apparently applied partial baseline.
				if (!state?.schema) await tx.execute(sql`create schema drizzle`);
				await tx.execute(sql`create table if not exists drizzle.__drizzle_migrations (
					id serial primary key, hash text not null, created_at bigint not null, name text not null,
					applied_at timestamp with time zone not null default now()
				)`);
				for (const migration of migrationAssets.slice(rows.length)) {
					for (const statement of migration.sql)
						await tx.execute(sql.raw(statement));
					await tx.execute(
						sql`insert into drizzle.__drizzle_migrations (hash, created_at, name) values (${migration.hash}, ${migration.folderMillis}, ${migration.name})`,
					);
				}
				// Roles are provisioned by the operator; isolated superuser fixtures need none.
				await tx.execute(sql`do $$ begin
					if exists (select 1 from pg_roles where rolname = 'keyzori_server') then
						revoke all on public.audit_logs, public.usage_operations from keyzori_server;
						grant select, insert on public.audit_logs, public.usage_operations to keyzori_server;
						revoke all on drizzle.__drizzle_migrations from keyzori_server;
						grant select on drizzle.__drizzle_migrations to keyzori_server;
						revoke all on sequence drizzle.__drizzle_migrations_id_seq from keyzori_server;
					end if;
				end $$`);
			});
		} finally {
			try {
				if (locked) await connection`select pg_advisory_unlock(6284, 0)`;
			} finally {
				await connection`select set_config('lock_timeout', ${timeouts.lock}, false), set_config('statement_timeout', ${timeouts.statement}, false)`;
			}
		}
	}
}
