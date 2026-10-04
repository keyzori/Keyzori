import { expect, test } from "bun:test";
import { MigrationService } from "../../core/database/MigrationService";
import { TestDatabase } from "../fixtures/TestDatabase";

async function catalogue(fixture: TestDatabase) {
	return fixture.database.client<{ schema: string; name: string }[]>`
		select n.nspname as schema, c.relname as name
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname not in ('pg_catalog', 'information_schema')
		and n.nspname not like 'pg_toast%'
		order by n.nspname, c.relname`;
}

test("v1 databases are refused before creating v2 migration state or changing data", async () => {
	const fixture = new TestDatabase();
	await fixture.start(false);
	try {
		const legacy = await Bun.file(
			new URL("../fixtures/v1-migration.sql", import.meta.url),
		).text();
		for (const statement of legacy.split("--> statement-breakpoint"))
			await fixture.database.client.unsafe(statement);
		await fixture.database.client`insert into keyzori_application values (2)`;
		await fixture.database.client`insert into customers (id, name, email)
			values ('00000000-0000-4000-8000-000000000001', 'Preserved legacy customer', 'legacy@example.invalid')`;
		await fixture.database.client`create schema keyzori_migrations`;
		await fixture.database
			.client`create table keyzori_migrations.core (name text, hash text)`;
		await fixture.database
			.client`insert into keyzori_migrations.core values ('20260909225201_powerful_firedrake', 'legacy-history')`;
		const before = await catalogue(fixture);
		await expect(new MigrationService(fixture.database).run()).rejects.toThrow(
			"fresh database",
		);
		expect(await catalogue(fixture)).toEqual(before);
		expect(
			await fixture.database.client<
				{ id: string; name: string; email: string }[]
			>`select id, name, email from customers`,
		).toEqual([
			{
				id: "00000000-0000-4000-8000-000000000001",
				name: "Preserved legacy customer",
				email: "legacy@example.invalid",
			},
		]);
		expect(
			await fixture.database.client<
				{ name: string; hash: string }[]
			>`select * from keyzori_migrations.core`,
		).toEqual([
			{
				name: "20260909225201_powerful_firedrake",
				hash: "legacy-history",
			},
		]);
	} finally {
		await fixture.stop();
	}
});

test("an unversioned nonempty database is refused without adding v2 tables", async () => {
	const fixture = new TestDatabase();
	await fixture.start(false);
	try {
		await fixture.database.client`create table unrelated_data (value text)`;
		await fixture.database
			.client`insert into unrelated_data values ('Keep this data')`;
		const before = await catalogue(fixture);
		await expect(new MigrationService(fixture.database).run()).rejects.toThrow(
			"fresh database",
		);
		expect(await catalogue(fixture)).toEqual(before);
		expect(
			await fixture.database.client<
				{ value: string }[]
			>`select * from unrelated_data`,
		).toEqual([{ value: "Keep this data" }]);
	} finally {
		await fixture.stop();
	}
});

test.each(["missing", "empty"])(
	"existing v2 data with %s migration history is refused without changing schema or data",
	async (history) => {
		const fixture = new TestDatabase();
		await fixture.start();
		try {
			await fixture.database
				.client`insert into settings values (1, '{"preserved":true}'::jsonb)`;
			if (history === "missing")
				await fixture.database.client`drop table drizzle.__drizzle_migrations`;
			else
				await fixture.database.client`delete from drizzle.__drizzle_migrations`;
			const before = await catalogue(fixture);
			await expect(
				new MigrationService(fixture.database).run(),
			).rejects.toThrow("fresh database");
			expect(await catalogue(fixture)).toEqual(before);
			expect(
				await fixture.database.client<
					{ id: number; value: { preserved: boolean } }[]
				>`select * from settings`,
			).toEqual([{ id: 1, value: { preserved: true } }]);
		} finally {
			await fixture.stop();
		}
	},
);
