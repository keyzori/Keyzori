import { expect, test } from "bun:test";
import { MigrationService } from "../../core/database/MigrationService";
import { TestDatabase } from "../fixtures/TestDatabase";
import {
	migrationAssets,
	migrationFingerprint,
} from "../../core/database/migrationAssets";

async function catalogue(fixture: TestDatabase) {
	return fixture.database.client<{ schema: string; name: string }[]>`
		select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
		where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
		order by n.nspname,c.relname`;
}

test("serve preflight refuses an empty database without creating tables", async () => {
	const fixture = new TestDatabase();
	await fixture.start(false);
	try {
		const before = await catalogue(fixture);
		await expect(
			new MigrationService(fixture.database).verify(),
		).rejects.toThrow("migration history is missing");
		expect(await catalogue(fixture)).toEqual(before);
	} finally {
		await fixture.stop();
	}
});

test("an unversioned nonempty database is refused without changing persistent data", async () => {
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
			Array.from(
				await fixture.database.client<
					{ value: string }[]
				>`select * from unrelated_data`,
			),
		).toEqual([{ value: "Keep this data" }]);
	} finally {
		await fixture.stop();
	}
});

test.each(["missing", "empty", "modified", "newer"])(
	"%s migration history fails closed without repairing data",
	async (history) => {
		const fixture = new TestDatabase();
		await fixture.start();
		try {
			await fixture.database.client`create table preserved_data (value text)`;
			await fixture.database
				.client`insert into preserved_data values ('Preserved')`;
			if (history === "missing")
				await fixture.database.client`drop table drizzle.__drizzle_migrations`;
			else if (history === "empty")
				await fixture.database.client`delete from drizzle.__drizzle_migrations`;
			else if (history === "modified")
				await fixture.database
					.client`update drizzle.__drizzle_migrations set hash='changed'`;
			else
				await fixture.database
					.client`insert into drizzle.__drizzle_migrations(hash,created_at,name) values ('future',9999999999999,'future')`;
			const before = await catalogue(fixture);
			await expect(
				new MigrationService(fixture.database).verify(),
			).rejects.toThrow();
			await expect(
				new MigrationService(fixture.database).run(),
			).rejects.toThrow();
			expect(await catalogue(fixture)).toEqual(before);
			expect(
				Array.from(
					await fixture.database.client<
						{ value: string }[]
					>`select * from preserved_data`,
				),
			).toEqual([{ value: "Preserved" }]);
		} finally {
			await fixture.stop();
		}
	},
);

test("compatible history passes read-only verification", async () => {
	const fixture = new TestDatabase();
	await fixture.start();
	try {
		const before = await catalogue(fixture);
		expect(await new MigrationService(fixture.database).verify()).toEqual({
			migrations: migrationAssets.length,
			fingerprint: migrationFingerprint,
		});
		expect(await catalogue(fixture)).toEqual(before);
	} finally {
		await fixture.stop();
	}
});

test("concurrent fresh migrators serialize the complete baseline and serve remains read-only", async () => {
	const fixture = new TestDatabase();
	await fixture.start(false);
	try {
		await Promise.all([
			new MigrationService(fixture.database).run(),
			new MigrationService(fixture.database).run(),
		]);
		const history = await fixture.database.client<
			{ hash: string; name: string }[]
		>`select hash, name from drizzle.__drizzle_migrations order by created_at, id`;
		expect(Array.from(history)).toEqual(
			migrationAssets.map(({ name, hash }) => ({ name, hash })),
		);
		await new MigrationService(fixture.database).verify();
	} finally {
		await fixture.stop();
	}
}, 30000);

test("a terminated mid-DDL migrator rolls back schema and journal and can be retried", async () => {
	const fixture = new TestDatabase();
	await fixture.start(false);
	let migration: Promise<unknown> | undefined;
	try {
		// Disposable superuser-only test hook; pg_catalog keeps it outside the user
		// schema preflight. The advisory marker proves DDL actually started.
		await fixture.database
			.client`create function pg_catalog.keyzori_test_interrupt() returns event_trigger language plpgsql as $$ begin
			perform pg_advisory_xact_lock(6284, 9876);
			perform pg_sleep(30);
		end $$`;
		await fixture.database
			.client`create event trigger keyzori_test_interrupt on ddl_command_end when tag in ('CREATE TABLE') execute function pg_catalog.keyzori_test_interrupt()`;
		const before = await catalogue(fixture);
		migration = new MigrationService(fixture.database).run().then(
			() => "unexpected-success",
			() => "interrupted",
		);
		let backend: number | undefined;
		const deadline = Date.now() + 5000;
		while (!backend && Date.now() < deadline) {
			const [lock] = await fixture.database.client<
				{ pid: number }[]
			>`select pid from pg_locks where locktype = 'advisory' and classid = 6284 and objid = 9876 and granted and database = (select oid from pg_database where datname = current_database())`;
			backend = lock?.pid;
			if (!backend) await Bun.sleep(10);
		}
		expect(backend).toBeDefined();
		if (!backend) throw new Error("Migration did not enter DDL");
		await fixture.database.client`select pg_terminate_backend(${backend})`;
		expect(await migration).toBe("interrupted");
		expect(await catalogue(fixture)).toEqual(before);
		await fixture.database.client`drop event trigger keyzori_test_interrupt`;
		await fixture.database
			.client`drop function pg_catalog.keyzori_test_interrupt()`;
		await new MigrationService(fixture.database).run();
		await new MigrationService(fixture.database).verify();
	} finally {
		await fixture.stop();
		await migration;
	}
}, 45000);

test.each(["timestamp", "name", "duplicate"])(
	"%s history tampering is refused without rewriting the journal",
	async (mutation) => {
		const fixture = new TestDatabase();
		await fixture.start();
		try {
			if (mutation === "timestamp")
				await fixture.database
					.client`update drizzle.__drizzle_migrations set created_at = created_at + 1`;
			else if (mutation === "name")
				await fixture.database
					.client`update drizzle.__drizzle_migrations set name = 'changed'`;
			else
				await fixture.database
					.client`insert into drizzle.__drizzle_migrations(hash, created_at, name) select hash, created_at, name from drizzle.__drizzle_migrations limit 1`;
			const before = await fixture.database
				.client`select * from drizzle.__drizzle_migrations order by id`;
			await expect(
				new MigrationService(fixture.database).verify(),
			).rejects.toThrow("incompatible");
			await expect(
				new MigrationService(fixture.database).run(),
			).rejects.toThrow("incompatible");
			expect(
				await fixture.database
					.client`select * from drizzle.__drizzle_migrations order by id`,
			).toEqual(before);
		} finally {
			await fixture.stop();
		}
	},
);
