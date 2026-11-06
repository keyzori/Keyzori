import { asc, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { apiKeys } from "../database/schema/apiKeys";
import { apiKeyGroups } from "../database/schema/apiKeyGroups";
import { SecretHasher } from "../security/SecretHasher";
import { ScopeService } from "./ScopeService";
import { HttpError } from "../http/HttpError";
import type { Database } from "../database/Database";
import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";
import type { $ApiKey } from "../../types/apiKeys";

export class AuthService {
	private readonly hasher = new SecretHasher();
	private readonly scopes = new ScopeService();
	private readonly masterHash;
	constructor(
		private readonly database: Pick<Database, "transaction">,
		master: string,
	) {
		this.masterHash = this.hasher.hash(master);
	}

	async authenticate(
		header: string | null,
		deadlineAt?: number,
	): Promise<$Principal> {
		if (deadlineAt !== undefined && Date.now() >= deadlineAt)
			throw new HttpError("SERVICE_UNAVAILABLE");
		const credential = header?.match(/^Bearer ([^\r\n]+)$/i)?.[1];
		if (!credential || credential.length > 4096)
			throw new HttpError("UNAUTHORIZED");
		if (this.hasher.matches(credential, this.masterHash))
			return { kind: "root", id: "root", name: "Root", scopes: [] };
		const parsed =
			/^kz_key_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})_([a-f0-9]{64})$/.exec(
				credential,
			);
		const id = parsed?.[1];
		const secret = parsed?.[2];
		if (!id || !secret) throw new HttpError("UNAUTHORIZED");
		return this.database.transaction(
			async (tx) => {
				const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id));
				if (!key || !this.hasher.matches(secret, key.secretHash))
					throw new HttpError("UNAUTHORIZED");
				const now = await this.now(tx);
				this.active(key, now);
				if (
					!key.lastUsedAt ||
					now.getTime() - key.lastUsedAt.getTime() >= 60000
				)
					await tx
						.update(apiKeys)
						.set({ lastUsedAt: now })
						.where(eq(apiKeys.id, key.id));
				return this.principal(tx, key);
			},
			"read",
			deadlineAt,
		);
	}

	/**
	 * Rechecks a key and holds a shared row lock until this transaction ends.
	 * Grant edits, disable, deletion and rotation wait for authorized work; later
	 * transactions see those changes. Acquire this lock before resource locks.
	 */
	async authorize(
		tx: $Transaction,
		principal: $Principal,
		scope: string,
	): Promise<$Principal> {
		if (principal.kind === "root") return principal;
		const [key] = await tx
			.select()
			.from(apiKeys)
			.where(eq(apiKeys.id, principal.id))
			.for("share");
		if (!key || key.secretHash !== principal.credentialHash)
			throw new HttpError("UNAUTHORIZED");
		this.active(key, await this.now(tx));
		const current = await this.principal(tx, key);
		this.require(current, scope);
		return current;
	}

	require(principal: $Principal, scope: string) {
		if (principal.kind === "root") return;
		if (!this.scopes.allows(principal.scopes, scope))
			throw new HttpError("FORBIDDEN");
	}

	requireGroup(principal: $Principal, groupId: string | null) {
		if (principal.kind === "root" || principal.allGroups) return;
		if (groupId === null || !principal.groupIds.includes(groupId.toLowerCase()))
			throw new HttpError("FORBIDDEN");
	}

	/** SQL predicate for a group ID column, including nullable licence groups. */
	groupFilter(principal: $Principal, column: AnyPgColumn) {
		if (principal.kind === "root" || principal.allGroups) return undefined;
		return principal.groupIds.length
			? inArray(column, principal.groupIds)
			: sql`false`;
	}

	requireAllGroups(principal: $Principal) {
		if (principal.kind !== "root" && !principal.allGroups)
			throw new HttpError("FORBIDDEN");
	}

	private active(key: $ApiKey, now: Date) {
		if (!key.enabled || (key.expiresAt && key.expiresAt <= now))
			throw new HttpError("UNAUTHORIZED");
		if (!this.scopes.validStored(key.scopes)) throw new HttpError("FORBIDDEN");
	}

	private async principal(tx: $Transaction, key: $ApiKey): Promise<$Principal> {
		const grants = await tx
			.select({ groupId: apiKeyGroups.groupId })
			.from(apiKeyGroups)
			.where(eq(apiKeyGroups.apiKeyId, key.id))
			.orderBy(asc(apiKeyGroups.groupId));
		return {
			kind: "api",
			id: key.id,
			name: key.name,
			scopes: key.scopes,
			credentialHash: key.secretHash,
			allGroups: key.allGroups,
			groupIds: grants.map((grant) => grant.groupId),
		};
	}

	private async now(tx: $Transaction) {
		const [clock] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!clock) throw new Error("Database time unavailable");
		return clock.now;
	}
}
