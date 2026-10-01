import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import type { $Transaction } from "../../types/database";
import { HttpError } from "../http/HttpError";
import type { Metrics } from "../observability/Metrics";

export class Database {
	readonly client;
	readonly orm;
	constructor(
		url: string,
		poolSize = 10,
		private readonly metrics?: Metrics,
	) {
		this.client = new SQL(url, {
			max: poolSize,
			connectionTimeout: 3,
			idleTimeout: 30,
			connection: {
				statement_timeout: "12000",
				lock_timeout: "5000",
				idle_in_transaction_session_timeout: "15000",
			},
		});
		this.orm = drizzle({ client: this.client });
	}
	async ping(deadlineAt = Date.now() + 4000) {
		await this.transaction(
			async (tx) => {
				await tx.execute(sql`select 1`);
			},
			"read",
			Math.min(deadlineAt, Date.now() + 4000),
		);
		return true;
	}
	async transaction<T>(
		work: (tx: $Transaction) => Promise<T>,
		topology: "read" | "write" = "read",
		deadlineAt?: number,
	) {
		if (deadlineAt !== undefined && !Number.isSafeInteger(deadlineAt))
			throw new Error("Invalid database deadline");
		const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + 14000);
		try {
			using reserved = await this.client.reserve({
				signal: AbortSignal.timeout(this.remaining(deadline)),
			});
			this.remaining(deadline);
			let callbackFinished: Promise<unknown> = Promise.resolve();
			let closing: Promise<void> | undefined;
			const timer = setTimeout(() => {
				closing = reserved.close({ timeout: 0 }).catch(() => undefined);
			}, this.remaining(deadline));
			try {
				return await drizzle({ client: reserved }).transaction(
					(tx) => {
						const workResult = (async () => {
							const remaining = this.remaining(deadline);
							await tx.execute(sql`select
					set_config('transaction_timeout', ${`${remaining}ms`}, true),
					set_config('statement_timeout', ${`${Math.min(12000, remaining)}ms`}, true),
					set_config('lock_timeout', ${`${Math.min(5000, remaining)}ms`}, true)`);
							await tx.execute(
								topology === "write"
									? sql`select pg_advisory_xact_lock(6284, 1)`
									: sql`select pg_advisory_xact_lock_shared(6284, 1)`,
							);
							this.remaining(deadline);
							const result = await work(tx);
							this.remaining(deadline);
							return result;
						})();
						callbackFinished = workResult.catch(() => undefined);
						return workResult;
					},
					{ isolationLevel: "read committed" },
				);
			} finally {
				await callbackFinished;
				clearTimeout(timer);
				await closing;
			}
		} catch (error) {
			this.metrics?.transactionFailure();
			if (Date.now() >= deadline || this.unavailable(error))
				throw new HttpError("SERVICE_UNAVAILABLE");
			throw error;
		}
	}
	private remaining(deadlineAt: number) {
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) throw new HttpError("SERVICE_UNAVAILABLE");
		return remaining;
	}
	private unavailable(error: unknown, depth = 0): boolean {
		if (depth > 5 || !error || typeof error !== "object") return false;
		if ("name" in error && error.name === "TimeoutError") return true;
		if (
			"errno" in error &&
			typeof error.errno === "string" &&
			(["53300", "57014", "55P03", "25P04", "57P01", "57P02", "57P03"].includes(
				error.errno,
			) ||
				error.errno.startsWith("08"))
		)
			return true;
		if (
			"code" in error &&
			typeof error.code === "string" &&
			([
				"53300",
				"57014",
				"55P03",
				"25P04",
				"57P01",
				"57P02",
				"57P03",
				"ERR_POSTGRES_CONNECTION_CLOSED",
				"ERR_POSTGRES_CONNECTION_TIMEOUT",
				"ERR_POSTGRES_CONNECTION_REFUSED",
				"ERR_POSTGRES_EXPECTED_REQUEST",
				"ECONNREFUSED",
				"ECONNRESET",
				"ENOTFOUND",
			].includes(error.code) ||
				error.code.startsWith("08"))
		)
			return true;
		return "cause" in error && this.unavailable(error.cause, depth + 1);
	}
	async close() {
		await this.client.close({ timeout: 5 });
	}
}
