import { and, eq, sql } from "drizzle-orm";
import { receipts } from "../database/schema/receipts";
import { HttpError } from "../http/HttpError";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type { $AdminOptions } from "../../types/idempotency";
import type { Database } from "../database/Database";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import { Replay } from "./Replay";
import { InputPolicy } from "../http/InputPolicy";

export class IdempotencyService {
	constructor(
		private readonly database: Database,
		private readonly settings: SettingsService,
	) {}
	async admin<T extends Record<string, unknown>>(
		context: $Operation,
		operation: string,
		input: unknown,
		mutation: (tx: $Transaction, now: Date) => Promise<T>,
		options: $AdminOptions<T> = {},
	) {
		const key = new InputPolicy().idempotency(
			context.idempotencyKey,
			options.secretIds !== undefined,
		);
		const fingerprint = this.fingerprint(input);
		return this.database.transaction(
			async (tx) => {
				const [clock] = await tx
					.select({ now: sql<Date>`clock_timestamp()` })
					.from(sql`(values (1)) as clock`);
				if (!clock) throw new Error("Database time unavailable");
				if (key) {
					const receipt = await this.existing(
						tx,
						operation,
						context.principal.id,
						key,
						fingerprint,
						input,
					);
					if (receipt?.result) throw new Replay(receipt.result);
				}
				const result = await mutation(tx, clock.now);
				if (key) {
					const settings = await this.settings.read(tx);
					await this.save(tx, {
						operation,
						principalId: context.principal.id,
						key,
						fingerprint,
						secretIssued: options.secretIds?.(result),
						result: options.secretIds ? null : result,
						expiresAt: new Date(
							clock.now.getTime() + settings.idempotencyRetentionSeconds * 1000,
						),
					});
				}
				return result;
			},
			options.topology,
			context.deadlineAt,
		);
	}
	fingerprint(value: unknown): string {
		return this.hash(value, false);
	}
	private hash(value: unknown, legacy: boolean): string {
		return new Bun.CryptoHasher("sha256")
			.update(this.canonical(value, legacy))
			.digest("hex");
	}
	private canonical(value: unknown, legacy: boolean): string {
		if (Array.isArray(value))
			return `[${value.map((item) => this.canonical(item, legacy)).join(",")}]`;
		if (value && typeof value === "object") {
			return `{${Object.entries(value)
				.sort(([a], [b]) =>
					legacy ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0,
				)
				.map(
					([key, item]) =>
						`${JSON.stringify(key)}:${this.canonical(item, legacy)}`,
				)
				.join(",")}}`;
		}
		return JSON.stringify(value) ?? "null";
	}
	async existing(
		tx: $Transaction,
		operation: string,
		principalId: string,
		key: string,
		fingerprint: string,
		input?: unknown,
	) {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([operation, principalId, key])}, 0))`,
		);
		const where = and(
			eq(receipts.operation, operation),
			eq(receipts.principalId, principalId),
			eq(receipts.key, key),
		);
		const [entry] = await tx
			.select({
				receipt: receipts,
				expired: sql<boolean>`${receipts.expiresAt} <= clock_timestamp()`,
			})
			.from(receipts)
			.where(where);
		if (!entry) return;
		const receipt = entry.receipt;
		if (entry.expired) {
			await tx.delete(receipts).where(where);
			return;
		}
		// Keep pre-fix receipts replayable without writing locale-dependent hashes.
		if (
			receipt.fingerprint !== fingerprint &&
			(input === undefined || receipt.fingerprint !== this.hash(input, true))
		)
			throw new HttpError("IDEMPOTENCY_KEY_REUSED");
		if (receipt.secretIssued)
			throw new HttpError(
				"SECRET_ALREADY_ISSUED",
				undefined,
				receipt.secretIssued,
			);
		return receipt;
	}
	async save(tx: $Transaction, input: typeof receipts.$inferInsert) {
		await tx.insert(receipts).values(input);
	}
}
