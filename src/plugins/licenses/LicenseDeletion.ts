import { asc, eq, inArray } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import { HttpError } from "../../core/http/HttpError";
import type { AuditService } from "../audits/AuditService";
import type { EventService } from "../webhooks/EventService";
import type { $Transaction } from "../../types/database";
import type { $Operation } from "../../types/operation";

export class LicenseDeletion {
	constructor(
		private readonly audit: AuditService,
		private readonly events: EventService,
	) {}
	async remove(
		tx: $Transaction,
		ids: string[],
		operation: $Operation,
		reason: string,
	) {
		if (!ids.length) return;
		const rows = await tx
			.select()
			.from(licenses)
			.where(inArray(licenses.id, ids))
			.orderBy(asc(licenses.id))
			.for("update");
		if (rows.length !== ids.length)
			throw new HttpError("BULK_OPERATION_FAILED");
		for (const row of rows) {
			await this.audit.record(tx, {
				...operation,
				actor: operation.principal,
				action: "license.deleted",
				targetType: "license",
				targetId: row.id,
				reason,
				before: {
					id: row.id,
					userId: row.userId,
					itemId: row.itemId,
					enabled: row.enabled,
					expiresAt: row.expiresAt?.toISOString() ?? null,
				},
			});
			await this.events.emit(tx, "license.deleted", { licenseId: row.id });
			await tx.delete(licenses).where(eq(licenses.id, row.id));
		}
	}
}
