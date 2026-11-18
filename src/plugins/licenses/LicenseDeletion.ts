import { eq } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import {
	deleteChildren,
	deletionImage,
	type DeletionChild,
} from "./LicenseCascade";
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
		rows: DeletionChild[],
		operation: $Operation,
		reason: string,
		now: Date,
	) {
		if (rows.length > 1)
			return deleteChildren(tx, rows, operation, reason, now);
		const row = rows[0];
		if (row) {
			await this.audit.record(tx, {
				...operation,
				actor: operation.principal,
				action: "license.deleted",
				targetType: "license",
				targetId: row.id,
				groupId: row.groupId,
				reason,
				before: deletionImage(row),
			});
			await this.events.emit(
				tx,
				"license.deleted",
				{ licenseId: row.id, groupId: row.groupId },
				now,
			);
			await tx.delete(licenses).where(eq(licenses.id, row.id));
		}
	}
}
