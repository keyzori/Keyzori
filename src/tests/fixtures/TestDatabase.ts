import { sql } from "drizzle-orm";
import { Database } from "../../core/database/Database";
import { MigrationService } from "../../core/database/MigrationService";

export class TestDatabase {
	readonly database;
	readonly url;
	private readonly admin;
	private roles?: { runtime: string; migration: string };
	private created = false;
	private readonly name = `keyzori_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
	constructor() {
		const value = Bun.env.KZ_TEST_DATABASE_URL;
		if (!value)
			throw new Error("KZ_TEST_DATABASE_URL is required for integration tests");
		const url = new URL(value);
		if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname))
			throw new Error("Tests require an isolated local database");
		this.admin = new Database(value, 2);
		url.pathname = this.name;
		this.url = url.href;
		this.database = new Database(url.href, 20);
	}
	async start(migrate = true) {
		await this.admin.orm.execute(
			sql`create database ${sql.identifier(this.name)}`,
		);
		this.created = true;
		if (migrate) await new MigrationService(this.database).run();
	}
	/** Provision only inside the test-services runner's disposable cluster.
	 * No schema migration is run; smoke tests invoke the actual CLI separately. */
	async startWithRoles(): Promise<{
		runtimeUrl: string;
		migrationUrl: string;
	}> {
		if (!/^[a-f0-9-]{36}$/.test(Bun.env.KZ_TEST_RUN_ID ?? ""))
			throw new Error(
				"Restricted role fixtures require the owned test-services runner",
			);
		await this.start(false);
		const suffix = this.name.slice("keyzori_test_".length);
		const roles = {
			runtime: `kz_runtime_${suffix}`,
			migration: `kz_owner_${suffix}`,
		};
		const password = () =>
			Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		const runtimePassword = password();
		const migrationPassword = password();
		try {
			await this.admin.client.begin(async (tx) => {
				// Cluster-scoped roles: serialize initialization in the COMMON admin DB.
				// Never change/drop an existing grantee or another fixture's login.
				await tx`select pg_advisory_xact_lock(6284, 92)`;
				await tx`do $$ begin if not exists (select 1 from pg_roles where rolname='keyzori_server') then
					create role keyzori_server nologin; end if; end $$`;
				await tx.unsafe(
					`create role ${roles.runtime} login password '${runtimePassword}'`,
				);
				await tx.unsafe(
					`create role ${roles.migration} login password '${migrationPassword}'`,
				);
				await tx.unsafe(
					`grant keyzori_server to ${roles.runtime} with inherit true, set false`,
				);
			});
			this.roles = roles;
			const script = await Bun.file(
				new URL("../../../deploy/postgres/01-roles.sh", import.meta.url),
			).text();
			const provision = script
				.replaceAll("\r\n", "\n")
				.split("-- Database-local provisioning follows.\n")[1]
				?.split("\nSQL")[0];
			if (!provision)
				throw new Error("Missing database-local provisioning SQL");
			const local = provision
				.replaceAll(':"database_name"', `"${this.name}"`)
				.replaceAll(':"runtime_login"', `"${roles.runtime}"`)
				.replaceAll(':"schema_owner"', `"${roles.migration}"`);
			await this.database.client.unsafe(local).simple();
		} catch {
			await this.stop();
			throw new Error("Disposable database role provisioning failed");
		}
		const url = (role: string, secret: string) => {
			const value = new URL(this.url);
			value.username = role;
			value.password = secret;
			return value.href;
		};
		return {
			runtimeUrl: url(roles.runtime, runtimePassword),
			migrationUrl: url(roles.migration, migrationPassword),
		};
	}
	async stop() {
		await this.database.close();
		try {
			if (this.created)
				await this.admin.orm.execute(
					sql`drop database if exists ${sql.identifier(this.name)} with (force)`,
				);
			if (this.roles)
				await this.admin.orm.execute(
					sql`drop role ${sql.identifier(this.roles.runtime)}, ${sql.identifier(this.roles.migration)}`,
				);
			this.roles = undefined;
			this.created = false;
		} finally {
			await this.admin.close();
		}
	}
}
