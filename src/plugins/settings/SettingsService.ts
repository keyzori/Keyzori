import { IdempotencyService } from "../../core/security/IdempotencyService";
import { eq } from "drizzle-orm";
import { settings } from "../../core/database/schema/settings";
import { settingsDefaults } from "./defaults";
import { KeyGenerator } from "../../core/security/KeyGenerator";
import { HttpError } from "../../core/http/HttpError";
import type { Database } from "../../core/database/Database";
import type { ClientIpResolver } from "../../core/http/ClientIpResolver";
import type { AuditService } from "../audits/AuditService";
import type { $Transaction } from "../../types/database";
import type { $Settings, $SettingsChanges } from "../../types/settings";
import type { $Principal } from "../../types/auth";
import type { $RequestContext } from "../../types/http";

export class SettingsService {
	constructor(
		private readonly database: Database,
		private readonly audit: AuditService,
		private readonly ip: ClientIpResolver,
	) {}
	async read(tx?: $Transaction, deadlineAt?: number): Promise<$Settings> {
		if (!tx)
			return this.database.transaction(
				(transaction) => this.read(transaction),
				"read",
				deadlineAt,
			);
		const [row] = await tx.select().from(settings).where(eq(settings.id, 1));
		return row?.value ?? structuredClone(settingsDefaults);
	}
	async update(
		changes: $SettingsChanges,
		principal: $Principal,
		context: $RequestContext & { idempotencyKey?: string },
		reason?: string,
	) {
		if (principal.kind !== "root") throw new HttpError("FORBIDDEN");
		if (changes.globalKeyFormat) {
			try {
				new KeyGenerator().validate(changes.globalKeyFormat);
			} catch {
				throw new HttpError("INVALID_REQUEST", {
					globalKeyFormat: "Invalid key format or insufficient entropy",
				});
			}
		}
		if (changes.globalDeniedIps) this.ip.validateRules(changes.globalDeniedIps);
		for (const origin of changes.corsOrigins ?? []) {
			if (origin === "*") continue;
			try {
				const parsed = new URL(origin);
				if (
					!["http:", "https:"].includes(parsed.protocol) ||
					parsed.origin !== origin
				)
					throw new Error("origin");
			} catch {
				throw new HttpError("INVALID_REQUEST", {
					corsOrigins: "Origins must be exact HTTP(S) origins or *",
				});
			}
		}
		return new IdempotencyService(this.database, this).admin(
			{ ...context, principal },
			"settings.update",
			{ changes, reason },
			async (tx) => {
				const before = await this.read(tx);
				const after = { ...before, ...changes };
				const diff = this.audit.changes(before, after);
				if (diff.changed) {
					await tx
						.insert(settings)
						.values({ id: 1, value: after })
						.onConflictDoUpdate({ target: settings.id, set: { value: after } });
					await this.audit.record(tx, {
						...context,
						actor: principal,
						action: "settings.updated",
						targetType: "settings",
						reason,
						before: diff.before,
						after: diff.after,
					});
				}
				return { data: after };
			},
			{ topology: "write" },
		);
	}
}
