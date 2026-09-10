import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { relations } from "./relations.ts";

export class Database {
	readonly sql: SQL;
	readonly orm;
	constructor(url: string) {
		this.sql = new SQL(url, { max: 20, connectionTimeout: 5, idleTimeout: 30 });
		this.orm = drizzle({ client: this.sql, relations });
	}
	async ping() {
		await this.sql`SELECT 1`;
	}
	async close() {
		await this.sql.close({ timeout: 5 });
	}
}

export type Db = Database["orm"];
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Transaction;
