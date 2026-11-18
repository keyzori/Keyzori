import { and, eq, sql } from "drizzle-orm";
import { receipts } from "../database/schema/receipts";
import { HttpError } from "../http/HttpError";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";
import type { $AdminOptions } from "../../types/idempotency";
import type { $Principal } from "../../types/auth";
import { requireUnexpired, type AuthService } from "../auth/AuthService";
import type { Database } from "../database/Database";
import type { SettingsService } from "../../plugins/settings/SettingsService";
import { Replay } from "./Replay";
import { InputPolicy } from "../http/InputPolicy";
import {
	adminReceiptContract,
	checkAdminResult,
	checkIssuedIds,
	replayProjection,
} from "./adminReceipts";
import {
	authorizeReceipt,
	commandRequirements,
	retainedAuthority,
} from "./ReceiptAuthority";

export class IdempotencyService {
	constructor(
		private readonly database: Pick<
			Database,
			"transaction" | "idempotentTransaction"
		>,
		private readonly settings: Pick<SettingsService, "read">,
		private readonly auth?: Pick<AuthService, "authorize" | "groupFilter">,
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
		const contract = adminReceiptContract(operation);
		if (
			(contract.issued === true) !== (options.secretIds !== undefined) ||
			(options.scope !== undefined &&
				(options.scope !== contract.scope || !options.authority))
		)
			throw new Error("Inconsistent administrative receipt policy");
		const key = policy.idempotency(
			context.idempotencyKey,
			options.secretIds !== undefined,
		);
		if (
			context.principal.kind === "api" &&
			(contract.scope === "root" || !options.authorize || !this.auth)
		)
			throw new HttpError("FORBIDDEN");
		const fingerprint = key ? this.fingerprint(input) : "";
		const transaction = key
			? this.database.idempotentTransaction.bind(this.database)
			: this.database.transaction.bind(this.database);
		return transaction(
			async (tx) => {
				let principal = context.principal;
				if (options.scope && principal.kind === "api") {
					if (!this.auth) throw new HttpError("FORBIDDEN");
					principal = await this.auth.authorize(tx, principal, options.scope);
				} else if (!options.scope && options.authorize)
					principal = await options.authorize(tx);
				if (
					principal.kind !== context.principal.kind ||
					principal.id !== context.principal.id ||
					(context.principal.kind === "api" &&
						(principal.kind !== "api" ||
							principal.credentialHash !== context.principal.credentialHash))
				)
					throw new HttpError("UNAUTHORIZED");
				if (
					principal.kind === "api" &&
					!principal.scopes.includes(contract.scope)
				)
					throw new HttpError("FORBIDDEN");
				if (key) await this.replay(tx, operation, principal, key, fingerprint);
				if (options.scope && options.authorize) await options.authorize(tx);
				const authority = key
					? retainedAuthority(
							contract.scope,
							options.authority
								? await options.authority(tx, principal)
								: await commandRequirements(
										tx,
										operation,
										input,
										principal,
										this.auth,
									),
							principal,
						)
					: null;
				const now = await this.now(tx);
				requireUnexpired(principal, now);
				const result = await mutation(tx, now);
				checkAdminResult(operation, result, principal);
				if (key) {
					const secretIssued = options.secretIds?.(result);
					if (options.secretIds) checkIssuedIds(secretIssued);
					const settings = await this.settings.read(tx);
					await tx.insert(receipts).values({
						operation,
						principalId: context.principal.id,
						key,
						version: 2,
						fingerprint,
						authority,
						secretIssued,
						result: options.secretIds ? null : result,
						expiresAt: new Date(
							now.getTime() + settings.idempotencyRetentionSeconds * 1000,
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
	private async now(tx: $Transaction) {
		const [clock] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!clock) throw new Error("Database time unavailable");
		return clock.now;
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
	private async replay(
		tx: $Transaction,
		operation: string,
		principal: $Principal,
		key: string,
		fingerprint: string,
	) {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([operation, principal.id, key])}, 0))`,
		);
		const where = and(
			eq(receipts.operation, operation),
			eq(receipts.principalId, principal.id),
			eq(receipts.key, key),
		);
		const [entry] = await tx
			.select({
				receipt: receipts,
				expired: sql<boolean>`${receipts.expiresAt} <= clock_timestamp()`,
				now: sql<Date>`clock_timestamp()`,
			})
			.from(receipts)
			.where(where);
		if (!entry) return;
		const receipt = entry.receipt;
		if (entry.expired) {
			await tx.delete(receipts).where(where);
			return;
		}
		// Never reinterpret an unexpired old/unknown fingerprint or re-run its mutation.
		if (receipt.version !== 2) throw new HttpError("IDEMPOTENCY_KEY_REUSED");
		const contract = adminReceiptContract(operation);
		requireUnexpired(principal, entry.now);
		authorizeReceipt(principal, receipt.authority, contract.scope);
		if (receipt.fingerprint !== fingerprint)
			throw new HttpError("IDEMPOTENCY_KEY_REUSED");
		if (contract.issued) {
			if (receipt.result !== null) throw new HttpError("INTERNAL_ERROR");
			checkIssuedIds(receipt.secretIssued);
			if (
				principal.kind === "api" &&
				(operation === "license.create" || operation === "webhook.create")
			) {
				// Recovery IDs from a create belong to an existing target now, not
				// only to the originally proposed resource in the request body.
				const requirements = await commandRequirements(
					tx,
					operation === "license.create"
						? "license.rotate"
						: "webhook.rotate-secret",
					{ ids: receipt.secretIssued },
					principal,
					this.auth,
				);
				retainedAuthority(contract.scope, requirements, principal);
				requireUnexpired(principal, await this.now(tx));
			}
			throw new HttpError(
				"SECRET_ALREADY_ISSUED",
				undefined,
				receipt.secretIssued,
			);
		}
		if (receipt.secretIssued !== null || !receipt.result)
			throw new HttpError("INTERNAL_ERROR");
		throw new Replay(replayProjection(operation, receipt.result, principal));
	}
}
