import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { sql } from "drizzle-orm";
import { TestDatabase } from "../tests/fixtures/TestDatabase";
import { command } from "./command";
import type { Database } from "../core/database/Database";

/** Compare actual database definitions, not generator snapshot filenames. */
async function definitions(database: Database) {
	return database.client<{ kind: string; name: string; definition: string }[]>`
	select 'column' as kind, c.relname || '.' || a.attname as name,
		format_type(a.atttypid,a.atttypmod) || ';notnull=' || a.attnotnull::text ||
		';default=' || coalesce(pg_get_expr(d.adbin,d.adrelid),'') || ';identity=' || a.attidentity::text as definition
	from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
	left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
	where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
	union all
	select 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid,true)
	from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
	where n.nspname='public'
	union all
	select 'index', indexname, indexdef from pg_indexes where schemaname='public'
	union all
	select 'table', c.relname, 'rls=' || c.relrowsecurity::text || ';force=' || c.relforcerowsecurity::text
	from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')
	union all
	select 'enum', t.typname || '.' || e.enumsortorder::text, e.enumlabel
	from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
	union all
	select 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid,true)
	from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
	where n.nspname='public' and not t.tgisinternal
	union all
	select 'sequence', c.relname,
		format_type(s.seqtypid,null) || ';start=' || s.seqstart::text || ';increment=' || s.seqincrement::text ||
		';min=' || s.seqmin::text || ';max=' || s.seqmax::text || ';cache=' || s.seqcache::text || ';cycle=' || s.seqcycle::text ||
		';owned=' || coalesce(owner.relname || '.' || attribute.attname, '')
	from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
	left join pg_depend dependency on dependency.objid=c.oid and dependency.classid='pg_class'::regclass and dependency.deptype in ('a','i')
	left join pg_class owner on owner.oid=dependency.refobjid
	left join pg_attribute attribute on attribute.attrelid=owner.oid and attribute.attnum=dependency.refobjsubid
	where n.nspname='public'
	union all
	select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
	from pg_proc p join pg_namespace n on n.oid=p.pronamespace
	where n.nspname='public' and p.prokind in ('f','p')
	union all
	select 'policy', tablename || '.' || policyname,
		permissive || ';roles=' || roles::text || ';command=' || cmd || ';using=' || coalesce(qual,'') || ';check=' || coalesce(with_check,'')
	from pg_policies where schemaname='public'
	order by kind,name`;
}

/** Migrations must not mutate cluster-wide role authority as a side effect. */
async function roles(database: Database) {
	return database.client`
	select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
		rolreplication, rolbypassrls, rolconnlimit, rolconfig,
		array(select granted.rolname from pg_auth_members member
			join pg_roles granted on granted.oid=member.roleid where member.member=role.oid order by granted.rolname) as memberships
	from pg_roles role order by rolname`;
}

const root = resolve(".cache");
await Bun.write(join(root, ".keep"), "");
const temporary = await mkdtemp(join(root, "migrations-"));
const relativePath = relative(root, temporary);
if (relativePath.startsWith("..") || !relativePath.startsWith("migrations-"))
	throw new Error("Unsafe temporary migration path");
const actual = new TestDatabase();
const expected = new TestDatabase();
const failures: unknown[] = [];
try {
	const output = join(temporary, "generated");
	const config = join(temporary, "drizzle.config.ts");
	await Bun.write(
		config,
		`export default { dialect: "postgresql", schema: "./src/core/database/schema/*.ts", out: ${JSON.stringify(output)} };\n`,
	);
	await command(
		[
			process.execPath,
			"x",
			"--bun",
			"--no-install",
			"drizzle-kit",
			"generate",
			`--config=${config}`,
		],
		{ timeoutMs: 60000 },
	);
	await actual.start(false);
	const authority = await roles(actual.database);
	const { MigrationService } =
		await import("../core/database/MigrationService");
	await new MigrationService(actual.database).run();
	assert.deepEqual(
		await roles(actual.database),
		authority,
		"Migrations changed cluster-wide role authority",
	);
	await expected.start(false);
	const files = (
		await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: output }))
	).sort();
	assert.ok(files.length, "Schema generator produced no SQL");
	await expected.database.orm.transaction(async (tx) => {
		for (const file of files) {
			const content = await Bun.file(join(output, file)).text();
			for (const statement of content.split("--> statement-breakpoint"))
				if (statement.trim()) await tx.execute(sql.raw(statement));
		}
	});
	assert.deepEqual(
		await definitions(actual.database),
		await definitions(expected.database),
		"Committed migration SQL differs from the authoritative Drizzle schema",
	);
	console.log(
		"Migration SQL matches fresh Drizzle columns, defaults, constraints, indexes, enums, triggers, sequences, functions and policies; role authority is unchanged",
	);
} catch (error) {
	failures.push(error);
} finally {
	const cleanup = await Promise.allSettled([
		actual.stop(),
		expected.stop(),
		rm(temporary, { recursive: true, force: true }),
	]);
	for (const result of cleanup)
		if (result.status === "rejected") failures.push(result.reason);
}
if (failures.length)
	throw new AggregateError(
		failures,
		"Schema verification or fixture cleanup failed",
	);
