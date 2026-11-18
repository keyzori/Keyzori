import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import type { $Transaction } from "../../types/database";
import { HttpError } from "../http/HttpError";
import { Replay } from "../security/Replay";
import type { Metrics } from "../observability/Metrics";

type Topology = "read" | "write" | "none";
const requestBudget = {
	total: 14000,
	reserve: 14000,
	statement: 12000,
	lock: 5000,
};
const schemaBudgets = {
	verify: { total: 10000, reserve: 5000, statement: 5000, lock: 5000 },
	migrate: { total: 120000, reserve: 5000, statement: 60000, lock: 10000 },
	restore: { total: 120000, reserve: 5000, statement: 60000, lock: 10000 },
};

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
			// Drizzle's int8 sequence/revision columns are declared in bigint mode.
			// Bun otherwise returns strings, including for the reserved-session path.
			bigint: true,
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
			"none",
			Math.min(deadlineAt, Date.now() + 4000),
		);
		return true;
	}
	async transaction<T>(
		work: (tx: $Transaction) => Promise<T>,
		topology: Topology = "read",
		deadlineAt?: number,
	) {
		try {
			return await this.bounded(work, topology, requestBudget, deadlineAt);
		} catch (error) {
			throw this.failure(error);
		}
	}
	/** Offline operations have their own wall-clock budget, including BEGIN and COMMIT. */
	schemaTransaction<T>(
		mode: keyof typeof schemaBudgets,
		work: (tx: $Transaction) => Promise<T>,
		deadlineAt?: number,
	) {
		return this.bounded(work, "none", schemaBudgets[mode], deadlineAt);
	}
	private async bounded<T>(
		work: (tx: $Transaction) => Promise<T>,
		topology: Topology,
		budget: typeof requestBudget,
		deadlineAt?: number,
	) {
		if (deadlineAt !== undefined && !Number.isSafeInteger(deadlineAt))
			throw new Error("Invalid database deadline");
		const deadline = Math.min(
			deadlineAt ?? Infinity,
			Date.now() + budget.total,
		);
		try {
			using reserved = await this.client.reserve({
				signal: AbortSignal.timeout(
					Math.min(budget.reserve, this.remaining(deadline)),
				),
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
					case when current_setting('server_version_num')::integer >= 170000 then
						set_config('transaction_timeout', ${`${remaining}ms`}, true) end,
					set_config('statement_timeout', ${`${Math.min(budget.statement, remaining)}ms`}, true),
					set_config('lock_timeout', ${`${Math.min(budget.lock, remaining)}ms`}, true)`);
							if (topology !== "none")
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
			if (Date.now() >= deadline || this.unavailable(error))
				throw new HttpError("SERVICE_UNAVAILABLE");
			if (error instanceof Replay) this.metrics?.transactionRollback("replay");
			else if (error instanceof HttpError && error.status < 500)
				this.metrics?.transactionRollback("expected");
			else if (this.retryableConflict(error))
				this.metrics?.transactionRollback("conflict");
			throw error;
		}
	}
	private failure(error: unknown) {
		// Replay deliberately unwinds the transaction; rejected domain operations
		// likewise say nothing about database health. Count final failures once.
		if (this.retryableConflict(error))
			return new HttpError("SERVICE_UNAVAILABLE");
		if (!(
			error instanceof Replay ||
			(error instanceof HttpError && error.status < 500)
		))
			this.metrics?.transactionFailure();
		return error;
	}
	private remaining(deadlineAt: number) {
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) throw new HttpError("SERVICE_UNAVAILABLE");
		return remaining;
	}
	/** Only callbacks with durable operation identity and no external effects may opt in. */
	async idempotentTransaction<T>(
		work: (tx: $Transaction) => Promise<T>,
		topology: Topology = "read",
		deadlineAt?: number,
	): Promise<T> {
		const deadline = Math.min(
			deadlineAt ?? Infinity,
			Date.now() + requestBudget.total,
		);
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.bounded(work, topology, requestBudget, deadline);
			} catch (error) {
				// These errors prove rollback. Connection loss/unknown COMMIT is never retried.
				if (attempt >= 2 || !this.retryableConflict(error))
					throw this.failure(error);
				const delay = 10 * 2 ** attempt + Math.floor(Math.random() * 10);
				if (Date.now() + delay >= deadline) throw this.failure(error);
				await Bun.sleep(delay);
			}
		}
	}
	private retryableConflict(error: unknown, depth = 0): boolean {
		if (!error || typeof error !== "object" || depth > 5) return false;
		if (
			("code" in error && ["40001", "40P01"].includes(String(error.code))) ||
			("errno" in error && ["40001", "40P01"].includes(String(error.errno)))
		)
			return true;
		return "cause" in error && this.retryableConflict(error.cause, depth + 1);
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
