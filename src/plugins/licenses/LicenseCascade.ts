import { inArray, sql } from "drizzle-orm";
import { audits } from "../../core/database/schema/audits";
import {
	activityEvents,
	eventResources,
} from "../../core/database/schema/events";
import { licenses } from "../../core/database/schema/licenses";
import type { $Transaction } from "../../types/database";
import type { $License } from "../../types/licenses";
import type { $Operation } from "../../types/operation";
import { readEventEnvelope } from "../webhooks/events";

export const deletionColumns = {
	id: licenses.id,
	groupId: licenses.groupId,
	userId: licenses.userId,
	enabled: licenses.enabled,
	expiresAt: licenses.expiresAt,
};
export const detachColumns = {
	id: licenses.id,
	groupId: licenses.groupId,
	enabled: licenses.enabled,
	disabledReason: licenses.disabledReason,
};
type Child = Pick<$License, "id" | "groupId">;
export type DeletionChild = Pick<$License, keyof typeof deletionColumns>;
type DetachedChild = Pick<$License, keyof typeof detachColumns>;
type Lifecycle =
	"license.deleted" | "license.disabled" | "license.group_detached";

/** The caller holds these licence locks in UUID order. Allocate all revisions
 * before outbox ordinals; hashes, registration data and parent snapshots are never selected. */
async function recordChildren<T extends Child>(
	tx: $Transaction,
	children: T[],
	operation: $Operation,
	reason: string,
	now: Date,
	events: readonly Lifecycle[],
	evidence: (
		row: T,
	) => Pick<
		typeof audits.$inferInsert,
		"action" | "before" | "after" | "requiresAllGroups" | "requiredGroupIds"
	>,
) {
	const { kind, id, name } = operation.principal;
	for (let offset = 0; offset < children.length; offset += 100) {
		const batch = children.slice(offset, offset + 100);
		await tx.insert(audits).values(
			batch.map((row) => ({
				id: Bun.randomUUIDv7(),
				targetType: "license",
				targetId: row.id,
				groupId: row.groupId,
				global: false,
				actor: { kind, id, name },
				requestId: operation.requestId,
				clientIp: operation.clientIp || null,
				reason,
				createdAt: now,
				...evidence(row),
			})),
		);
		const revisions = await tx
			.insert(eventResources)
			.values(
				batch.map(({ id }) => ({
					type: "license",
					id,
					revision: BigInt(events.length),
				})),
			)
			.onConflictDoUpdate({
				target: [eventResources.type, eventResources.id],
				set: { revision: sql`${eventResources.revision} + excluded.revision` },
			})
			.returning({
				id: eventResources.id,
				revision: sql<string>`${eventResources.revision}::text`,
			});
		const last = new Map(
			revisions.map((row) => [row.id, BigInt(row.revision)]),
		);
		const outbox = batch.flatMap((row) =>
			events.map((event, i) => {
				const end = last.get(row.id);
				if (end === undefined)
					throw new Error("Missing licence event revision");
				const revision = end - BigInt(events.length - i - 1);
				const payload = readEventEnvelope({
					schemaVersion: 1,
					id: Bun.randomUUIDv7(),
					event,
					data: { licenseId: row.id, groupId: row.groupId },
					resource: { type: "license", id: row.id, revision: String(revision) },
					createdAt: now.toISOString(),
				});
				return {
					id: payload.id,
					event,
					payload,
					groupId: row.groupId,
					global: false,
					resourceId: row.id,
					resourceType: "license",
					resourceRevision: revision,
					createdAt: now,
				};
			}),
		);
		await tx.insert(activityEvents).values(outbox);
	}
}

export function deletionImage(row: DeletionChild) {
	return {
		id: row.id,
		userId: row.userId,
		groupId: row.groupId,
		enabled: row.enabled,
		expiresAt: row.expiresAt?.toISOString() ?? null,
	};
}

export async function deleteChildren(
	tx: $Transaction,
	children: DeletionChild[],
	operation: $Operation,
	reason: string,
	now: Date,
) {
	await recordChildren(
		tx,
		children,
		operation,
		reason,
		now,
		["license.deleted"],
		(row) => ({
			action: "license.deleted",
			before: deletionImage(row),
		}),
	);
	await tx.delete(licenses).where(
		inArray(
			licenses.id,
			children.map((row) => row.id),
		),
	);
}

/** Group authority covers the source-only invalidations; the combined audit also contains ungrouped state. */
export async function detachChildren(
	tx: $Transaction,
	children: DetachedChild[],
	operation: $Operation,
	reason: string,
	now: Date,
	preparing: boolean,
) {
	if (!children.length) return;
	const fallback = preparing
		? "Detached while preparing group deletion"
		: "Associated group was deleted";
	await tx
		.update(licenses)
		.set({
			enabled: false,
			groupId: null,
			disabledReason: sql`coalesce(${licenses.disabledReason}, ${fallback})`,
			updatedBy: operation.principal.id,
			updatedAt: now,
		})
		.where(
			inArray(
				licenses.id,
				children.map((row) => row.id),
			),
		);
	await recordChildren(
		tx,
		children,
		operation,
		reason,
		now,
		preparing
			? ["license.group_detached", "license.disabled"]
			: ["license.disabled"],
		(row) => {
			if (!row.groupId) throw new Error("Ungrouped licence in group cascade");
			return {
				action: preparing ? "license.group_detached" : "license.group_deleted",
				requiredGroupIds: [row.groupId],
				requiresAllGroups: true,
				before: { groupId: row.groupId, enabled: row.enabled },
				after: {
					groupId: null,
					enabled: false,
					disabledReason: row.disabledReason ?? fallback,
				},
			};
		},
	);
}
