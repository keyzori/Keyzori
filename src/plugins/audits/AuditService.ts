import { audits } from "../../core/database/schema/audits";
import { licenses } from "../../core/database/schema/licenses";
import { eq } from "drizzle-orm";
import { EventService } from "../webhooks/EventService";
import { webhookEvents } from "../webhooks/events";
import type { $AuditInput } from "../../types/audit";
import type { $Transaction } from "../../types/database";

export class AuditService {
	async record(tx: $Transaction, input: $AuditInput) {
		await this.write(tx, input);
	}
	/** A failure gate keeps its evidence ID across an indeterminate COMMIT. */
	recordOnce(tx: $Transaction, input: $AuditInput, evidenceId: string) {
		return this.write(tx, input, evidenceId);
	}
	private async write(
		tx: $Transaction,
		input: $AuditInput,
		evidenceId?: string,
	) {
		let groupId =
			input.groupId ??
			(input.targetType === "group" ? input.targetId : null) ??
			null;
		if (
			input.targetType === "license" &&
			input.targetId &&
			input.groupId === undefined
		) {
			const [row] = await tx
				.select({ groupId: licenses.groupId })
				.from(licenses)
				.where(eq(licenses.id, input.targetId));
			groupId = row?.groupId ?? null;
		}
		const insert = tx.insert(audits).values({
			groupId,
			requiredGroupIds: input.requiredGroupIds ?? [],
			requiresAllGroups: input.requiresAllGroups ?? false,
			global: input.targetType !== "license" && input.targetType !== "group",
			id: evidenceId ?? Bun.randomUUIDv7(),
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
		if (evidenceId) {
			const rows = await insert
				.onConflictDoNothing({ target: audits.id })
				.returning({ id: audits.id });
			if (!rows.length) return false;
		} else await insert;
		if (
			["api-key", "settings", "webhook"].includes(input.targetType) ||
			input.action.startsWith("license.hardware.") ||
			input.action.startsWith("license.ips.")
		) {
			const event = webhookEvents.find(
				(candidate) => candidate === input.action,
			);
			if (event)
				await new EventService().emitChecked(tx, event, {
					...(input.targetType === "license"
						? { licenseId: input.targetId, groupId }
						: input.targetType === "api-key"
							? { apiKeyId: input.targetId }
							: input.targetType === "webhook"
								? { webhookId: input.targetId }
								: {}),
				});
		}
		return true;
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
