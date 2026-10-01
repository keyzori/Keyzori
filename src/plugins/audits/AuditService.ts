import { audits } from "../../core/database/schema/audits";
import type { $AuditInput } from "../../types/audit";
import type { $Transaction } from "../../types/database";

export class AuditService {
	async record(tx: $Transaction, input: $AuditInput) {
		await tx.insert(audits).values({
			id: Bun.randomUUIDv7(),
			action: input.action,
			actor: {
				kind: input.actor.kind,
				id: input.actor.id,
				name: input.actor.name,
			},
			targetType: input.targetType,
			targetId: input.targetId,
			requestId: input.requestId,
			clientIp: input.clientIp || null,
			hardwareId: input.hardwareId,
			reason: input.reason,
			before: input.before,
			after: input.after,
		});
	}
	changes(before: Record<string, unknown>, after: Record<string, unknown>) {
		const changed = Object.keys(after).filter(
			(key) => !Bun.deepEquals(before[key], after[key], true),
		);
		return {
			before: Object.fromEntries(changed.map((key) => [key, before[key]])),
			after: Object.fromEntries(changed.map((key) => [key, after[key]])),
			changed: changed.length > 0,
		};
	}
}
