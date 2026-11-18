import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { TestDatabase } from "../fixtures/TestDatabase";
import { migrationAssets } from "../../core/database/migrationAssets";
import { MigrationService } from "../../core/database/MigrationService";
import { users } from "../../core/database/schema/users";
import { Database } from "../../core/database/Database";
import { audits } from "../../core/database/schema/audits";
import { usageOperations } from "../../core/database/schema/usageOperations";
import { Metrics } from "../../core/observability/Metrics";
import { Replay } from "../../core/security/Replay";
import { HttpError } from "../../core/http/HttpError";
import { RestoreService } from "../../core/database/RestoreService";

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
	const { runtimeUrl, migrationUrl } = await roles.startWithRoles();
	const runtime = new Database(runtimeUrl, 2);
	const migrator = new Database(migrationUrl, 2);
	try {
		await new MigrationService(migrator).run();
		await roles.database
			.client`revoke delete on public.event_resources, public.settings from keyzori_server`;
		await new MigrationService(runtime).verifyRuntime();
		await roles.database
			.client`revoke select on drizzle.__drizzle_migrations from keyzori_server`;
		await expect(
			new MigrationService(runtime).verifyRuntime(),
		).rejects.toMatchObject({ code: "RUNTIME_ROLE_REQUIRED" });
		await roles.database
			.client`grant select(id,hash,created_at,name) on drizzle.__drizzle_migrations to keyzori_server`;
		await new MigrationService(runtime).verifyRuntime();
		await expect(
			new MigrationService(migrator).verifyRuntime(),
		).rejects.toMatchObject({ code: "RUNTIME_ROLE_REQUIRED" });
		const before = await roles.database.client`select * from event_state`;
		await expect(new RestoreService(runtime).prepare()).rejects.toMatchObject({
			code: "MIGRATION_ROLE_REQUIRED",
		});
		expect(await roles.database.client`select * from event_state`).toEqual(
			before,
		);
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
			`set role "${new URL(migrationUrl).username}"`,
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
		await new MigrationService(runtime).verifyRuntime();
		const login = sql.identifier(new URL(runtimeUrl).username);
		await roles.database.orm.execute(
			sql`grant update(action) on public.audit_logs to ${login}`,
		);
		await new MigrationService(runtime).verify();
		await expect(
			new MigrationService(runtime).verifyRuntime(),
		).rejects.toMatchObject({ code: "RUNTIME_ROLE_REQUIRED" });
		await roles.database.orm.execute(
			sql`revoke update(action) on public.audit_logs from ${login}`,
		);
		await roles.database
			.client`grant delete on public.usage_operations to keyzori_server`;
		await expect(new RestoreService(migrator).prepare()).rejects.toMatchObject({
			code: "RUNTIME_ROLE_REQUIRED",
		});
		expect(await roles.database.client`select * from event_state`).toEqual(
			before,
		);
		expect(
			await roles.database
				.client`select 1 from audit_logs where action='system.restore_prepared'`,
		).toHaveLength(0);
	} finally {
		await runtime.close();
		await migrator.close();
		await roles.stop();
	}
}, 30000);

test("only rollback-proven conflicts are retried; exhaustion is retryable and expected rollbacks are classified separately", async () => {
	const metrics = new Metrics();
	const database = new Database(fixture.url, 1, metrics);
	try {
		for (const state of ["40001", "40P01"] as const) {
			const id = Bun.randomUUIDv7();
			let attempts = 0;
			await expect(
				database.idempotentTransaction(async (tx) => {
					attempts++;
					await tx.insert(users).values({
						id,
						name: "Rollback",
						createdBy: "test",
						updatedBy: "test",
					});
					await tx.execute(
						sql.raw(
							`do $$ begin raise exception 'fixture conflict' using errcode='${state}'; end $$`,
						),
					);
				}),
			).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
			expect(attempts).toBe(3);
			expect(
				await database.orm.select().from(users).where(eq(users.id, id)),
			).toHaveLength(0);
		}
		for (const error of [new Replay({ data: [] }), new HttpError("FORBIDDEN")])
			await expect(
				database.transaction(async () => {
					throw error;
				}),
			).rejects.toBe(error);
		expect(metrics.text()).toContain(
			'keyzori_transaction_rollbacks_total{kind="conflict"} 6',
		);
		expect(metrics.text()).toContain(
			'keyzori_transaction_rollbacks_total{kind="replay"} 1',
		);
		expect(metrics.text()).toContain(
			'keyzori_transaction_rollbacks_total{kind="expected"} 1',
		);
		expect(metrics.text()).not.toMatch(
			/^keyzori_transaction_failures_total [1-9]/m,
		);
	} finally {
		await database.close();
	}
});
