import { sql } from "drizzle-orm";
import { Database } from "../../core/database/Database";
import { MigrationService } from "../../core/database/MigrationService";

export class TestDatabase {
	readonly database;
	readonly url;
	private readonly admin;
	private readonly name =
		`keyzori_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
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
		if (migrate) await new MigrationService(this.database).run();
	}
	async stop() {
		await this.database.close();
		try {
			await this.admin.orm.execute(
				sql`drop database if exists ${sql.identifier(this.name)} with (force)`,
			);
		} finally {
			await this.admin.close();
		}
	}
}
