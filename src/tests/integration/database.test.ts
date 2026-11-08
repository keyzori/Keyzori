import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { TestDatabase } from "../fixtures/TestDatabase";
import { migrationAssets } from "../../core/database/migrationAssets";
import { MigrationService } from "../../core/database/MigrationService";
import { users } from "../../core/database/schema/users";
import { Database } from "../../core/database/Database";
import { audits } from "../../core/database/schema/audits";
import { usageOperations } from "../../core/database/schema/usageOperations";

const fixture = new TestDatabase();
beforeAll(() => fixture.start());
afterAll(() => fixture.stop());

test("migrations re-run concurrently without adding history", async () => {
	await Promise.all([
		new MigrationService(fixture.database).run(),
		new MigrationService(fixture.database).run(),
	]);
	const rows = await fixture.database.client<
		{ count: string }[]
	>`select count(*) from drizzle.__drizzle_migrations`;
	expect(Number(rows[0]?.count)).toBe(migrationAssets.length);
});

test("transaction rollback removes its state and licence-independent locks allow concurrency", async () => {
	const id = Bun.randomUUIDv7();
	await expect(
		fixture.database.transaction(async (tx) => {
			await tx
				.insert(users)
				.values({ id, name: "Rollback", createdBy: "root", updatedBy: "root" });
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	expect(
		await fixture.database.orm.select().from(users).where(eq(users.id, id)),
	).toHaveLength(0);
	let unlock = () => {};
	const barrier = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	let entered = () => {};
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const first = fixture.database.transaction(async () => {
		entered();
		await barrier;
	});
	await ready;
	await fixture.database.transaction(async (tx) => {
		await tx.execute(sql`select 1`);
	});
	unlock();
	await first;
});

test("PostgreSQL retains exact numeric, jsonb and equivalent IPv6 semantics", async () => {
	const [row] = await fixture.database.client<
		{
			decimal: string;
			network: boolean;
			metadata: { id: string; count: number };
		}[]
	>`
		select (0.1::numeric + 0.2::numeric)::text as decimal,
		'2001:db8::1'::inet = '2001:0db8:0:0:0:0:0:1'::inet as network,
		'{"id":"12","count":12}'::jsonb as metadata`;
	expect(row).toEqual({
		decimal: "0.3",
		network: true,
		metadata: { id: "12", count: 12 },
	});
});

test("PostgreSQL connection exhaustion returns unavailable and recovers after capacity returns", async () => {
	const role = `keyzori_limit_${Bun.randomUUIDv7().replaceAll("-", "")}`;
	const password = Buffer.from(
		crypto.getRandomValues(new Uint8Array(24)),
	).toString("hex");
	const url = new URL(fixture.url);
	url.username = role;
	url.password = password;
	const first = new Database(url.href, 1);
	const second = new Database(url.href, 1);
	await fixture.database.orm.execute(
		sql`create role ${sql.identifier(role)} login connection limit 1 password ${sql.raw(`'${password}'`)}`,
	);
	try {
		await first.ping();
		await expect(second.ping()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		await first.close();
		expect(await second.ping()).toBe(true);
	} finally {
		await first.close();
		await second.close();
		await fixture.database.orm.execute(sql`drop role ${sql.identifier(role)}`);
	}
});

test("modified migration history is refused", async () => {
	await fixture.database
		.client`update drizzle.__drizzle_migrations set hash = 'changed'`;
	await expect(new MigrationService(fixture.database).run()).rejects.toThrow(
		"incompatible",
	);
});

test("provisioned runtime can insert evidence but cannot DDL, rewrite evidence or change history", async () => {
	const roles = new TestDatabase();
	await roles.start(false);
	const password = Buffer.from(
		crypto.getRandomValues(new Uint8Array(24)),
	).toString("hex");
	const runtimeUrl = new URL(roles.url);
	runtimeUrl.username = "keyzori_server";
	runtimeUrl.password = password;
	const migrationUrl = new URL(roles.url);
	migrationUrl.username = "keyzori_migrator";
	migrationUrl.password = password;
	const runtime = new Database(runtimeUrl.href, 2);
	const migrator = new Database(migrationUrl.href, 2);
	try {
		// Execute the checked-in provisioning SQL, with psql variables expanded only
		// from fixture-owned identifiers and a generated hexadecimal password.
		const script = await Bun.file(
			new URL("../../../deploy/postgres/01-roles.sh", import.meta.url),
		).text();
		const provision = script
			.split("<<'SQL'")[1]
			?.replace(/\r\n/g, "\n")
			.trim()
			.replace(/\nSQL$/, "")
			.split("\n")
			.filter((line) => !line.startsWith("\\getenv "))
			.join("\n")
			.replaceAll(":'server_password'", `'${password}'`)
			.replaceAll(":'migration_password'", `'${password}'`)
			.replaceAll(
				':"database_name"',
				`"${new URL(roles.url).pathname.slice(1)}"`,
			);
		if (!provision) throw new Error("Missing provisioning SQL");
		await roles.database.client.unsafe(provision).simple();
		await new MigrationService(migrator).run();
		await new MigrationService(runtime).verify();
		const id = Bun.randomUUIDv7();
		await runtime.orm.insert(users).values({
			id,
			name: "Allowed runtime mutation",
			createdBy: "root",
			updatedBy: "root",
		});
		await runtime.orm
			.update(users)
			.set({ name: "Allowed update" })
			.where(eq(users.id, id));
		await runtime.orm.insert(audits).values({
			id,
			action: "test.accepted",
			actor: { kind: "system", id: "test", name: "Test" },
			targetType: "user",
			targetId: id,
			requestId: id,
		});
		await runtime.orm.insert(usageOperations).values({
			id,
			licenseId: id,
			principalId: id,
			idempotencyKey: id,
			fingerprint: "fixture",
			requestId: id,
			entries: [],
		});
		const denied = [
			"create table public.runtime_ddl (id integer)",
			"create schema runtime_schema",
			"create temporary table runtime_temp (id integer)",
			"alter table public.users add column runtime_ddl text",
			"update public.audit_logs set action = 'changed'",
			"delete from public.audit_logs",
			"truncate public.audit_logs",
			"update public.usage_operations set fingerprint = 'changed'",
			"delete from public.usage_operations",
			"truncate public.usage_operations",
			"update drizzle.__drizzle_migrations set hash = 'changed'",
			"delete from drizzle.__drizzle_migrations",
			"truncate drizzle.__drizzle_migrations",
			"insert into drizzle.__drizzle_migrations(hash, created_at, name) values ('forged', 0, 'forged')",
			"set role keyzori_migrator",
		];
		for (const statement of denied)
			await expect(runtime.client.unsafe(statement)).rejects.toMatchObject({
				errno: "42501",
			});
		await expect(new MigrationService(runtime).run()).rejects.toThrow(
			"separate schema-owner credential",
		);
		expect(
			await runtime.orm.select().from(audits).where(eq(audits.id, id)),
		).toHaveLength(1);
		expect(
			await runtime.orm
				.select()
				.from(usageOperations)
				.where(eq(usageOperations.id, id)),
		).toHaveLength(1);
		await new MigrationService(runtime).verify();
	} finally {
		await runtime.close();
		await migrator.close();
		await roles.stop();
	}
}, 30000);
