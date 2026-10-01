import { eq, sql } from "drizzle-orm";
import { apiKeys } from "../database/schema/apiKeys";
import { licenses } from "../database/schema/licenses";
import { users } from "../database/schema/users";
import { items } from "../database/schema/items";
import { SecretHasher } from "../security/SecretHasher";
import { ScopeService } from "./ScopeService";
import { HttpError } from "../http/HttpError";
import type { Database } from "../database/Database";
import type { $Principal } from "../../types/auth";
import type { $Transaction } from "../../types/database";

export class AuthService {
	private readonly hasher = new SecretHasher();
	private readonly scopes = new ScopeService();
	private readonly masterHash;
	constructor(
		private readonly database: Database,
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
		const match = header?.match(/^Bearer ([^\r\n]+)$/);
		const credential = match?.[1];
		if (!credential || credential.length > 4096)
			throw new HttpError("UNAUTHORIZED");
		if (this.hasher.matches(credential, this.masterHash))
			return { kind: "root", id: "root", name: "Root", scopes: [] };
		return this.database.transaction(
			async (tx) => {
				const [clock] = await tx
					.select({ now: sql<Date>`clock_timestamp()` })
					.from(sql`(values (1)) as clock`);
				if (!clock) throw new Error("Database time unavailable");
				const api =
					/^kz_key_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})_([a-f0-9]{64})$/.exec(
						credential,
					);
				if (api?.[1] && api[2]) {
					const [key] = await tx
						.select()
						.from(apiKeys)
						.where(eq(apiKeys.id, api[1]));
					if (key && this.hasher.matches(api[2], key.secretHash)) {
						if (!key.enabled || (key.expiresAt && key.expiresAt <= clock.now))
							throw new HttpError("UNAUTHORIZED");
						if (
							!key.lastUsedAt ||
							clock.now.getTime() - key.lastUsedAt.getTime() >= 60000
						) {
							await tx
								.update(apiKeys)
								.set({ lastUsedAt: clock.now })
								.where(eq(apiKeys.id, key.id));
						}
						return {
							kind: "api",
							id: key.id,
							name: key.name,
							scopes: key.scopes,
						};
					}
				}
				const [license] = await tx
					.select()
					.from(licenses)
					.where(eq(licenses.keyHash, this.hasher.hash(credential)));
				if (
					!license?.enabled ||
					(license.expiresAt && license.expiresAt <= clock.now)
				)
					throw new HttpError("UNAUTHORIZED");
				if (license.userId) {
					const [parent] = await tx
						.select({ enabled: users.enabled })
						.from(users)
						.where(eq(users.id, license.userId));
					if (!parent?.enabled) throw new HttpError("UNAUTHORIZED");
				}
				if (license.itemId) {
					const [parent] = await tx
						.select({ enabled: items.enabled })
						.from(items)
						.where(eq(items.id, license.itemId));
					if (!parent?.enabled) throw new HttpError("UNAUTHORIZED");
				}
				return {
					kind: "license",
					id: license.id,
					name: "License",
					scopes: [],
					userId: license.userId,
					itemId: license.itemId,
					credentialHash: license.keyHash,
				};
			},
			"read",
			deadlineAt,
		);
	}
	async assertLicense(tx: $Transaction, principal: $Principal) {
		if (principal.kind !== "license") return;
		const [license] = await tx
			.select()
			.from(licenses)
			.where(eq(licenses.id, principal.id))
			.for("share");
		const [clock] = await tx
			.select({ now: sql<Date>`clock_timestamp()` })
			.from(sql`(values (1)) as clock`);
		if (!clock) throw new Error("Database time unavailable");
		if (
			!license?.enabled ||
			license.keyHash !== principal.credentialHash ||
			(license.expiresAt && license.expiresAt <= clock.now)
		)
			throw new HttpError("UNAUTHORIZED");
		if (license.userId) {
			const [parent] = await tx
				.select({ enabled: users.enabled })
				.from(users)
				.where(eq(users.id, license.userId))
				.for("share");
			if (!parent?.enabled) throw new HttpError("UNAUTHORIZED");
		}
		if (license.itemId) {
			const [parent] = await tx
				.select({ enabled: items.enabled })
				.from(items)
				.where(eq(items.id, license.itemId))
				.for("share");
			if (!parent?.enabled) throw new HttpError("UNAUTHORIZED");
		}
		return license;
	}
	require(principal: $Principal, scope: string) {
		if (scope === "self") {
			if (principal.kind !== "license") throw new HttpError("FORBIDDEN");
			return;
		}
		if (principal.kind === "root") return;
		if (principal.kind === "license") {
			if (["licenses:read", "users:read", "items:read"].includes(scope)) return;
			throw new HttpError("FORBIDDEN");
		}
		if (!this.scopes.allows(principal.scopes, scope))
			throw new HttpError("FORBIDDEN");
	}
}
