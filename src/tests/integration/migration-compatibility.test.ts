import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Database } from "../../core/database/Database";
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

// These three SQL files shipped together in the initial V3 baseline.
async function initialV3(fixture: TestDatabase, count = 3) {
	await fixture.start(false);
	await fixture.database.orm.transaction(async (tx) => {
		await tx.execute(sql`create schema drizzle`);
		await tx.execute(sql`create table drizzle.__drizzle_migrations (
			id serial primary key, hash text not null, created_at bigint not null, name text not null,
			applied_at timestamptz not null default now())`);
		for (const migration of migrationAssets.slice(0, count)) {
			for (const statement of migration.sql)
				await tx.execute(sql.raw(statement));
			await tx.execute(sql`insert into drizzle.__drizzle_migrations(hash,created_at,name)
				values (${migration.hash},${migration.folderMillis},${migration.name})`);
		}
	});
}

test.each([1, 3])(
	"the forward migration seeds a never-served %i-migration V3 prefix exactly once",
	async (count) => {
		const fixture = new TestDatabase();
		try {
			await initialV3(fixture, count);
			const service = new MigrationService(fixture.database);
			await service.run();
			const rows = await fixture.database
				.client`select epoch, sequence::text, retained_after::text from event_state`;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				epoch: expect.any(String),
				sequence: "0",
				retained_after: "0",
			});
			await service.run();
			expect(
				await fixture.database
					.client`select epoch, sequence::text, retained_after::text from event_state`,
			).toEqual(rows);
		} finally {
			await fixture.stop();
		}
	},
);

test.each(["events", "deliveries"])(
	"populated pre-authority %s refuse the prefix upgrade before DDL",
	async (kind) => {
		const fixture = new TestDatabase();
		try {
			await initialV3(fixture, 1);
			if (kind === "events")
				await fixture.database
					.client`insert into activity_events(id,event,payload,global,resource_type,resource_id,resource_revision)
			values(gen_random_uuid(),'license.updated','{}',false,'license','legacy',1)`;
			else
				await fixture.database
					.client`insert into webhook_deliveries(id,webhook_id,event_id,global,endpoint_version,url,secret_ciphertext,signing_key_id,payload,expires_at)
			values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),false,1,'https://fixture.invalid','fixture',gen_random_uuid(),'{}',now())`;
			const before = await fixture.database
				.client`select * from drizzle.__drizzle_migrations`;
			await expect(
				new MigrationService(fixture.database).run(),
			).rejects.toMatchObject({ code: "SCHEMA_INCOMPATIBLE" });
			expect(
				await fixture.database
					.client`select * from drizzle.__drizzle_migrations`,
			).toEqual(before);
			expect(
				await fixture.database
					.client`select 1 from information_schema.columns where table_schema='public'
			and table_name in ('activity_events','webhook_deliveries') and column_name='required_group_ids'`,
			).toHaveLength(0);
			expect(
				await fixture.database
					.client`select id from activity_events union all select id from webhook_deliveries`,
			).toHaveLength(1);
		} finally {
			await fixture.stop();
		}
	},
);

test("a missing V3 checkpoint with surviving revision tombstones refuses the upgrade atomically", async () => {
	const fixture = new TestDatabase();
	try {
		await initialV3(fixture);
		await fixture.database
			.client`insert into event_resources(type,id,revision) values('license','historical',3)`;
		await expect(
			new MigrationService(fixture.database).run(),
		).rejects.toThrow();
		expect(
			await fixture.database.client`select 1 from event_state`,
		).toHaveLength(0);
		expect(
			await fixture.database
				.client`select 1 from event_resources where revision=3`,
		).toHaveLength(1);
		expect(
			await fixture.database.client`select 1 from drizzle.__drizzle_migrations`,
		).toHaveLength(3);
	} finally {
		await fixture.stop();
	}
});

test("a populated upgrade preserves its checkpoint and unfinished work; terminal history gets a review interval", async () => {
	const fixture = new TestDatabase();
	try {
		await initialV3(fixture);
		const epoch = Bun.randomUUIDv7();
		await fixture.database
			.client`insert into event_state(id,epoch,sequence,retained_after) values(1,${epoch},17,17)`;
		await fixture.database
			.client`insert into webhook_deliveries (id,webhook_id,event_id,global,endpoint_version,url,secret_ciphertext,signing_key_id,payload,state,created_at,expires_at)
			select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),false,1,'https://fixture.invalid','fixture-cipher',gen_random_uuid(),'{}'::jsonb,state,timestamptz '2000-01-01 UTC',now()
			from (values ('pending'),('failed')) states(state)`;
		const service = new MigrationService(fixture.database);
		await service.run();
		const [checkpoint] = await fixture.database
			.client`select epoch,sequence::text,retained_after::text from event_state`;
		expect(checkpoint).toEqual({ epoch, sequence: "17", retained_after: "17" });
		const rows = await fixture.database
			.client`select state, secret_ciphertext, terminal_at, terminal_at >= statement_timestamp()-interval '1 minute' as recent from webhook_deliveries order by state`;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			state: "failed",
			secret_ciphertext: null,
			recent: true,
		});
		expect(rows[1]).toMatchObject({
			state: "pending",
			secret_ciphertext: "fixture-cipher",
			terminal_at: null,
		});
		await service.run();
		const [unchanged] = await fixture.database
			.client`select terminal_at from webhook_deliveries where state='failed'`;
		expect(unchanged?.terminal_at).toEqual(rows[0]?.terminal_at);
	} finally {
		await fixture.stop();
	}
});

test("serving preflight refuses inconsistent or missing publication state without repairing it", async () => {
	const fixture = new TestDatabase();
	const roles = await fixture.startWithRoles();
	const owner = new Database(roles.migrationUrl, 1);
	const runtime = new Database(roles.runtimeUrl, 1);
	try {
		await new MigrationService(owner).run();
		const service = new MigrationService(runtime);
		await service.verifyRuntime();
		await fixture.database.client`update event_state set sequence=9`;
		await expect(service.verifyRuntime()).rejects.toMatchObject({
			code: "SCHEMA_INCOMPATIBLE",
		});
		expect(
			(
				await fixture.database
					.client`select sequence::text as seq from event_state`
			)[0]?.seq,
		).toBe("9");
		await fixture.database.client`delete from event_state`;
		await expect(service.verifyRuntime()).rejects.toMatchObject({
			code: "SCHEMA_INCOMPATIBLE",
		});
		expect(
			await fixture.database.client`select 1 from event_state`,
		).toHaveLength(0);
	} finally {
		await Promise.all([owner.close(), runtime.close()]);
		await fixture.stop();
	}
});

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
