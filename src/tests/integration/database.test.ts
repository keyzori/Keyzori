import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { TestDatabase } from "../fixtures/TestDatabase";
import { migrationAssets } from "../../core/database/migrationAssets";
import { MigrationService } from "../../core/database/MigrationService";
import { users } from "../../core/database/schema/users";
import { Database } from "../../core/database/Database";

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
