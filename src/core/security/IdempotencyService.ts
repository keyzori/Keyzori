import { and, eq, sql } from "drizzle-orm";
import { receipts } from "../database/schema/receipts";
import { HttpError } from "../http/HttpError";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type { $AdminOptions } from "../../types/idempotency";
import type { $ReceiptAuthority } from "../../types/idempotency";
import type { $Principal } from "../../types/auth";
import type { AuthService } from "../auth/AuthService";
import type { Database } from "../database/Database";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import { Replay } from "./Replay";
import { InputPolicy } from "../http/InputPolicy";

export class IdempotencyService {
	constructor(
		private readonly database: Database,
		private readonly settings: SettingsService,
		private readonly auth?: Pick<AuthService, "authorize">,
	) {}
	async admin<T extends Record<string, unknown>>(
		context: $Operation,
		operation: string,
		input: unknown,
		mutation: (tx: $Transaction, now: Date) => Promise<T>,
		options: $AdminOptions<T> = {},
	) {
		const policy = new InputPolicy();
		policy.jsonText(input);
		const key = policy.idempotency(
			context.idempotencyKey,
			options.secretIds !== undefined,
		);
		if (context.principal.kind === "api" && !options.authorize)
			throw new HttpError("FORBIDDEN");
		const transaction = key
			? this.database.idempotentTransaction.bind(this.database)
			: this.database.transaction.bind(this.database);
		return transaction(
			async (tx) => {
				const principal = options.scope
					? context.principal.kind === "root"
						? context.principal
						: this.auth
							? await this.auth.authorize(tx, context.principal, options.scope)
							: (() => {
									throw new HttpError("FORBIDDEN");
								})()
					: options.authorize
						? await options.authorize(tx)
						: context.principal;
				if (
					principal.kind !== context.principal.kind ||
					principal.id !== context.principal.id ||
					(context.principal.kind === "api" &&
						(principal.kind !== "api" ||
							principal.credentialHash !== context.principal.credentialHash))
				)
					throw new HttpError("UNAUTHORIZED");
				const fingerprint = this.fingerprint({
					input,
					authority: options.scope
						? "retained-resource-authority"
						: principal.kind === "root"
							? "root"
							: {
									credentialHash: principal.credentialHash,
									scopes: [...principal.scopes].sort(),
									allGroups: principal.allGroups,
									groupIds: [...principal.groupIds].sort(),
								},
				});
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
						undefined,
						options.scope
							? (entry) =>
									this.authorizeReceipt(
										principal,
										entry.authority,
										options.scope,
									)
							: undefined,
					);
					if (receipt?.result) throw new Replay(receipt.result);
				}
				if (options.scope && options.authorize) await options.authorize(tx);
				const authority =
					options.scope && options.authority
						? {
								...(await options.authority(tx, principal)),
								scope: options.scope,
							}
						: null;
				if (options.scope && !authority)
					throw new Error("Missing receipt resource authority");
				const result = await mutation(tx, clock.now);
				if (key) {
					const settings = await this.settings.read(tx);
					await this.save(tx, {
						operation,
						principalId: context.principal.id,
						key,
						fingerprint,
						authority,
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
		return new Bun.CryptoHasher("sha256")
			.update(this.canonical(value))
			.digest("hex");
	}
	private canonical(value: unknown): string {
		if (Array.isArray(value))
			return `[${value.map((item) => this.canonical(item)).join(",")}]`;
		if (value && typeof value === "object") {
			return `{${Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`)
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
		_input?: unknown,
		authorize?: (receipt: typeof receipts.$inferSelect) => void,
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
		authorize?.(receipt);
		if (receipt.fingerprint !== fingerprint)
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
	private authorizeReceipt(
		principal: $Principal,
		authority: $ReceiptAuthority | null,
		scope?: string,
	) {
		if (
			!authority ||
			authority.scope !== scope ||
			!Array.isArray(authority.groupIds)
		)
			throw new HttpError("FORBIDDEN");
		if (principal.kind === "root") return;
		if (authority.ownerId && authority.ownerId !== principal.id)
			throw new HttpError("FORBIDDEN");
		if (authority.allGroups && !principal.allGroups)
			throw new HttpError("FORBIDDEN");
		if (authority.scopes?.some((action) => !principal.scopes.includes(action)))
			throw new HttpError("FORBIDDEN");
		if (
			!principal.allGroups &&
			authority.groupIds.some(
				(id) => id === null || !principal.groupIds.includes(id),
			)
		)
			throw new HttpError("FORBIDDEN");
	}
}
