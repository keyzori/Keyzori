import { sql } from "drizzle-orm";
import type { $Transaction } from "../../types/database";
import { migrationAssets, migrationFingerprint } from "./migrationAssets";
import type { Database } from "./Database";

export class MigrationError extends Error {
	constructor(
		readonly code:
			| "SCHEMA_INCOMPATIBLE"
			| "UNSUPPORTED_DATABASE_VERSION"
			| "MIGRATION_ROLE_REQUIRED"
			| "RUNTIME_ROLE_REQUIRED",
		message: string,
	) {
		super(message);
		this.name = "MigrationError";
	}
}

export class MigrationService {
	constructor(private readonly database: Database) {}

	/** History-only inspection is also available to privileged backup/provisioning tools. */
	verify(deadlineAt?: number) {
		return this.database.schemaTransaction(
			"verify",
			async (tx) => {
				await this.lock(tx);
				return this.history(tx);
			},
			deadlineAt,
		);
	}

	/** Check the connected login, not merely the name on the deployed grant script. */
	verifyRuntime(deadlineAt?: number) {
		return this.database.schemaTransaction(
			"verify",
			async (tx) => {
				await this.lock(tx);
				const history = await this.history(tx);
				await this.runtimeAuthority(tx, false);
				await this.publicationState(tx);
				return history;
			},
			deadlineAt,
		);
	}

	/** The caller retains BOTH fences through restore audit, epoch rotation and COMMIT. */
	async verifyRestore(tx: $Transaction) {
		await this.lock(tx);
		await this.owner(tx);
		const history = await this.history(tx);
		await this.runtimeAuthority(tx, true);
		await tx.execute(sql`select pg_advisory_xact_lock(6284, 1)`);
		await this.publicationState(tx);
		return history;
	}

	private async lock(tx: $Transaction, exclusive = false) {
		await tx.execute(
			exclusive
				? sql`select pg_advisory_xact_lock(6284, 0)`
				: sql`select pg_advisory_xact_lock_shared(6284, 0)`,
		);
		const [state] = await tx.execute<{ supported: boolean }>(
			sql`select current_setting('server_version_num')::integer >= 170000 as supported`,
		);
		if (!state?.supported)
			throw new MigrationError(
				"UNSUPPORTED_DATABASE_VERSION",
				"PostgreSQL 17 or later is required",
			);
	}

	private async owner(tx: $Transaction) {
		// CREATE or broad application DML alone is not ownership. USAGE means the
		// active role actually has the owner's rights without a later SET ROLE.
		const [state] = await tx.execute<{ permitted: boolean }>(sql`
			select current_user <> 'keyzori_server'
			and pg_has_role(current_user, (select nspowner from pg_namespace where nspname='public'), 'USAGE')
			and not exists (select 1 from pg_namespace where nspname='drizzle' and not pg_has_role(current_user, nspowner, 'USAGE'))
			and not exists (select 1 from pg_class where oid in
				(to_regclass('public.audit_logs'), to_regclass('public.usage_operations'), to_regclass('public.event_state'),
				 to_regclass('public.webhooks'), to_regclass('public.webhook_deliveries'), to_regclass('public.webhook_delivery_attempts'),
				 to_regclass('drizzle.__drizzle_migrations'))
				and not pg_has_role(current_user, relowner, 'USAGE')) as permitted`);
		if (!state?.permitted)
			throw new MigrationError(
				"MIGRATION_ROLE_REQUIRED",
				"The explicit database command requires a separate schema-owner credential",
			);
	}

	private async runtimeAuthority(tx: $Transaction, canonical: boolean) {
		// Offline the canonical privilege grantee is known; serving also checks
		// the actual login (including its own grants and SET-able memberships).
		const role = canonical ? sql`'keyzori_server'` : sql`current_user`;
		const login = canonical ? role : sql`session_user`;
		const [state] = await tx.execute<{ permitted: boolean }>(sql`
			with runtime as (select oid, rolcanlogin from pg_roles where rolname=${role}),
			reachable as (
				select r.* from pg_roles r where exists (select 1 from pg_roles a
					where a.rolname in (${role}, ${login}) and pg_has_role(a.oid, r.oid, 'SET'))
			), evidence as (select unnest(array['public.audit_logs'::regclass,'public.usage_operations'::regclass]) as id),
			journal as (select 'drizzle.__drizzle_migrations'::regclass as id)
			select exists (select 1 from runtime r where
				(not r.rolcanlogin or has_database_privilege(r.oid, current_database(), 'CONNECT'))
				and has_schema_privilege(r.oid, 'public', 'USAGE') and has_schema_privilege(r.oid, 'drizzle', 'USAGE')
				and not exists (select 1 from evidence e join pg_attribute a on a.attrelid=e.id
					cross join (values ('SELECT'),('INSERT')) needed(priv)
					where a.attnum>0 and not a.attisdropped and not has_column_privilege(r.oid,e.id,a.attnum,needed.priv))
				and not exists (select 1 from (values
					('drizzle.__drizzle_migrations','hash','SELECT'),('drizzle.__drizzle_migrations','id','SELECT'),
					('drizzle.__drizzle_migrations','created_at','SELECT'),('drizzle.__drizzle_migrations','name','SELECT'),
					('public.event_state','id','SELECT'),('public.event_state','epoch','SELECT'),
					('public.event_state','sequence','SELECT'),('public.event_state','retained_after','SELECT'),
					('public.event_state','sequence','UPDATE'),('public.event_state','retained_after','UPDATE'),
					('public.activity_events','id','SELECT'),('public.activity_events','ordinal','SELECT'),
					('public.activity_events','sequence','SELECT'),('public.activity_events','sequence','UPDATE'),
					('public.activity_events','published_at','UPDATE'),('public.webhooks','enabled','SELECT'),
					('public.webhooks','last_sequence','SELECT')) needed(relation,col,priv)
					where not has_column_privilege(r.oid,needed.relation,needed.col,needed.priv))
				and has_sequence_privilege(r.oid,'public.activity_events_ordinal_seq','USAGE'))
			and not exists (select 1 from reachable r where r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls
				or pg_has_role(r.oid, 'pg_execute_server_program', 'USAGE') or pg_has_role(r.oid, 'pg_write_server_files', 'USAGE')
				or pg_has_role(r.oid, 'pg_read_server_files', 'USAGE')
				or has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
				or has_schema_privilege(r.oid,'public','CREATE') or has_schema_privilege(r.oid,'drizzle','CREATE')
				or exists (select 1 from pg_class c where c.relnamespace in ('public'::regnamespace,'drizzle'::regnamespace)
					and c.relkind in ('r','p','S') and pg_has_role(r.oid, c.relowner,'USAGE'))
				or exists (select 1 from evidence where has_table_privilege(r.oid,id,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
					or has_any_column_privilege(r.oid,id,'UPDATE,REFERENCES'))
				or exists (select 1 from journal where has_table_privilege(r.oid,id,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
					or has_any_column_privilege(r.oid,id,'INSERT,UPDATE,REFERENCES'))
				or has_sequence_privilege(r.oid,'drizzle.__drizzle_migrations_id_seq','USAGE,UPDATE')
			) as permitted`);
		if (!state?.permitted)
			throw new MigrationError(
				"RUNTIME_ROLE_REQUIRED",
				"The database runtime grants are missing or unsafe",
			);
	}

	private async publicationState(tx: $Transaction) {
		// Check high water, both edges of the retained range, and endpoint positions
		// from one MVCC snapshot. The unique publication sequence indexes both edges.
		const [row] = await tx.execute<{ valid: boolean }>(sql`
			select exists (select 1 from public.event_state s where s.id=1
				and s.retained_after between 0 and s.sequence
				and (select min(sequence) from public.activity_events) is not distinct from
					(case when s.sequence>s.retained_after then s.retained_after+1 end)
				and (select max(sequence) from public.activity_events) is not distinct from
					(case when s.sequence>s.retained_after then s.sequence end)
				and not exists (select 1 from public.webhooks w where w.last_sequence>s.sequence
					or (w.enabled and w.last_sequence<s.retained_after))) as valid`);
		if (!row?.valid)
			throw new MigrationError(
				"SCHEMA_INCOMPATIBLE",
				"Database publication checkpoint is missing or inconsistent",
			);
	}

	private async history(tx: $Transaction, allowPrefix = false) {
		const [journal] = await tx.execute<{
			compatible: boolean;
			readable: boolean;
		}>(sql`
			select c.relkind='r' and count(a.attnum)=4 as compatible,
				has_schema_privilege(current_user,n.oid,'USAGE') and
				bool_and(has_column_privilege(current_user,c.oid,a.attnum,'SELECT')) as readable
			from pg_class c join pg_namespace n on n.oid=c.relnamespace
			left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attname in ('hash','created_at','name','id')
			where n.nspname='drizzle' and c.relname='__drizzle_migrations' group by c.oid,c.relkind,n.oid`);
		if (!allowPrefix && !journal)
			throw new MigrationError(
				"SCHEMA_INCOMPATIBLE",
				"Database migration history is missing; run the migration command first",
			);
		if (journal && !journal.compatible)
			throw new MigrationError(
				"SCHEMA_INCOMPATIBLE",
				"Database migration history structure is incompatible",
			);
		if (journal && !journal.readable)
			throw new MigrationError(
				"RUNTIME_ROLE_REQUIRED",
				"Database credential cannot read the complete migration journal",
			);
		const rows = journal
			? await tx.execute<{
					hash: string;
					created_at: string | bigint;
					name: string | null;
				}>(
					sql`select hash, created_at, name from drizzle.__drizzle_migrations order by created_at, id limit ${migrationAssets.length + 1}`,
				)
			: [];
		if (!allowPrefix && rows.length !== migrationAssets.length)
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
	}

	run(deadlineAt?: number) {
		return this.database.schemaTransaction(
			"migrate",
			async (tx) => {
				await this.lock(tx, true);
				await this.owner(tx);
				const history = await this.history(tx, true);
				// No published V3 server used this intermediate schema. An external
				// prefix with old event rows cannot prove their historical grants.
				if (
					history.migrations === 1 &&
					migrationAssets[0]?.name === "20261106105033_keyzori_v3"
				) {
					await tx.execute(
						sql`lock table public.activity_events, public.webhook_deliveries in share mode`,
					);
					const [legacy] = await tx.execute<{ populated: boolean }>(sql`
						select exists(select 1 from public.activity_events) or exists(select 1 from public.webhook_deliveries) as populated`);
					if (legacy?.populated)
						throw new MigrationError(
							"SCHEMA_INCOMPATIBLE",
							"Database migration history lacks historical authority for populated events or deliveries",
						);
				}
				if (!history.migrations) {
					const objects = await tx.execute(sql`
				select c.relname as name from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname not in ('pg_catalog', 'information_schema')
				and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
				and not (n.nspname = 'drizzle' and c.relname in ('__drizzle_migrations', '__drizzle_migrations_id_seq', '__drizzle_migrations_pkey'))
				union all select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
				where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
				union all select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
				where t.typtype in ('e', 'd') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
				limit 1`);
					if (objects.length)
						throw new MigrationError(
							"SCHEMA_INCOMPATIBLE",
							"A fresh database is required when migration history is missing or empty. Existing data was not changed.",
						);
				}
				const [schema] = await tx.execute<{ present: boolean }>(
					sql`select to_regnamespace('drizzle') is not null as present`,
				);
				if (!schema?.present) await tx.execute(sql`create schema drizzle`);
				await tx.execute(sql`create table if not exists drizzle.__drizzle_migrations (
				id serial primary key, hash text not null, created_at bigint not null, name text not null,
				applied_at timestamp with time zone not null default now()
			)`);
				for (const migration of migrationAssets.slice(history.migrations)) {
					for (const statement of migration.sql)
						await tx.execute(sql.raw(statement));
					await tx.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at, name)
					values (${migration.hash}, ${migration.folderMillis}, ${migration.name})`);
				}
				await tx.execute(sql`do $$ begin
				if exists (select 1 from pg_roles where rolname = 'keyzori_server') then
					grant usage on schema public, drizzle to keyzori_server;
					revoke all on public.audit_logs, public.usage_operations from keyzori_server;
					grant select, insert on public.audit_logs, public.usage_operations to keyzori_server;
					revoke all on drizzle.__drizzle_migrations from keyzori_server;
					grant select on drizzle.__drizzle_migrations to keyzori_server;
					revoke all on sequence drizzle.__drizzle_migrations_id_seq from keyzori_server;
				end if;
			end $$`);
			},
			deadlineAt,
		);
	}
}
