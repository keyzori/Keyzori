import { eq, sql } from "drizzle-orm";
import { licenses } from "../../core/database/schema/licenses";
import {
	activityEvents,
	eventResources,
} from "../../core/database/schema/events";
import type { $Transaction } from "../../types/database";
import type {
	$WebhookEvent,
	$EventInput,
	$EventEnvelope,
	$EventAuthority,
} from "../../types/webhooks";
import { eventAuthoritySchema, readEventEnvelope } from "./events";
import { Assert } from "typebox/value";
import type { $WebhookDelivery } from "../../types/webhookManagement";

export class StoredEventError extends Error {
	constructor() {
		super("Inconsistent persisted event");
	}
}

export function scopedEvent(event: $WebhookEvent) {
	return (
		event.startsWith("license.") ||
		event.startsWith("meter.") ||
		event.startsWith("group.") ||
		event === "usage.consumed" ||
		event === "validation.failed"
	);
}

function resourceOf(
	envelope: $EventEnvelope,
): Omit<$EventEnvelope["resource"], "revision"> {
	const data = envelope.data;
	if ("licenseId" in data && data.licenseId)
		return { type: "license", id: data.licenseId };
	if ("userId" in data) return { type: "user", id: data.userId };
	if ("apiKeyId" in data) return { type: "api-key", id: data.apiKeyId };
	if ("webhookId" in data) return { type: "webhook", id: data.webhookId };
	if (envelope.event === "settings.updated")
		return { type: "settings", id: "settings" };
	if ("groupId" in data && data.groupId)
		return { type: "group", id: data.groupId };
	return { type: "validation", id: "anonymous" };
}

type Snapshot = Pick<
	$WebhookDelivery,
	"payload" | "groupId" | "global" | "requiredGroupIds" | "requiresAllGroups"
>;

function checkedSnapshot(row: Snapshot, eventId: string) {
	try {
		if (Buffer.byteLength(JSON.stringify(row.payload)) > 32768)
			throw new StoredEventError();
		Assert(eventAuthoritySchema, {
			requiredGroupIds: row.requiredGroupIds,
			requiresAllGroups: row.requiresAllGroups,
		});
		const payload = readEventEnvelope(row.payload);
		const subject = resourceOf(payload);
		const global =
			!scopedEvent(payload.event) ||
			(payload.event === "validation.failed" &&
				payload.data.licenseId === null);
		if (
			payload.id !== eventId ||
			global !== row.global ||
			("groupId" in payload.data ? payload.data.groupId : null) !==
				row.groupId ||
			subject.type !== payload.resource.type ||
			subject.id !== payload.resource.id
		)
			throw new StoredEventError();
		return payload;
	} catch {
		// Validation diagnostics can contain the original JSON. Never expose them.
		throw new StoredEventError();
	}
}

/** One boundary for activity reads and outbound enqueue, before trusting persisted JSON. */
export function readStoredEvent(row: typeof activityEvents.$inferSelect) {
	const payload = checkedSnapshot(row, row.id);
	if (
		payload.event !== row.event ||
		payload.resource.type !== row.resourceType ||
		payload.resource.id !== row.resourceId ||
		payload.resource.revision !== String(row.resourceRevision) ||
		Date.parse(payload.createdAt) !== row.createdAt.getTime()
	)
		throw new StoredEventError();
	return payload;
}

/** Source events can be pruned. Delivery validation must stand on the snapshot alone. */
export function readStoredDelivery(row: Snapshot & { eventId: string }) {
	return checkedSnapshot(row, row.eventId);
}

export class EventService {
	async emit<const E extends $WebhookEvent>(
		tx: $Transaction,
		event: E,
		data: NoInfer<$EventInput<E>>,
		now = new Date(),
		authority: $EventAuthority = {},
	) {
		return this.emitChecked(tx, event, data, now, authority);
	}

	/** Registry-driven producers (for example audit actions) still validate exact payloads. */
	async emitChecked(
		tx: $Transaction,
		event: $WebhookEvent,
		input: unknown,
		now = new Date(),
		authority: $EventAuthority = {},
	) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Invalid event data");
		const data = { ...input };
		// UUID text in payloads/resource locks must match PostgreSQL's canonical
		// representation; case must never split a resource's revision sequence.
		for (const key of [
			"licenseId",
			"groupId",
			"userId",
			"apiKeyId",
			"webhookId",
			"operationId",
			"counterId",
		]) {
			if (key in data) {
				const value: unknown = Reflect.get(data, key);
				if (typeof value === "string")
					Object.assign(data, { [key]: value.toLowerCase() });
			}
		}
		Assert(eventAuthoritySchema, authority);
		const requiredGroupIds = [
			...new Set(
				(authority.requiredGroupIds ?? []).map((id) => id.toLowerCase()),
			),
		].sort();
		let groupId = "groupId" in data ? data.groupId : undefined;
		const licenseId = "licenseId" in data ? data.licenseId : undefined;
		if (
			(event === "license.group_detached" ||
				event === "license.group_attached") &&
			groupId === undefined
		)
			throw new Error("Transfer event authorization context is required");
		if (typeof licenseId === "string" && groupId === undefined) {
			const [license] = await tx
				.select({ groupId: licenses.groupId })
				.from(licenses)
				.where(eq(licenses.id, licenseId));
			if (!license) throw new Error("Missing event authorization context");
			groupId = license.groupId;
		}
		const scoped = scopedEvent(event);
		if (scoped) Object.assign(data, { groupId: groupId ?? null });
		if (event === "validation.failed") {
			Object.assign(data, { licenseId: licenseId ?? null });
			if ("clientIp" in data) delete data.clientIp;
			if ("hardwareId" in data) delete data.hardwareId;
		}
		const id = Bun.randomUUIDv7();
		// Validate before acquiring revision locks or persisting anything.
		const validated = readEventEnvelope({
			schemaVersion: 1,
			id,
			event,
			data,
			resource: { type: "validation", id, revision: "1" },
			createdAt: now.toISOString(),
		});
		const resource = resourceOf(validated);
		// The upsert holds a per-resource lock through COMMIT. Allocate ordinal only
		// afterwards: later revisions cannot become visible before an earlier one.
		const [version] = await tx
			.insert(eventResources)
			.values({ ...resource, revision: 1n })
			.onConflictDoUpdate({
				target: [eventResources.type, eventResources.id],
				set: { revision: sql`${eventResources.revision} + 1` },
			})
			.returning();
		if (!version) throw new Error("Event resource revision unavailable");
		const payload = readEventEnvelope({
			...validated,
			resource: { ...resource, revision: String(version.revision) },
		});
		if (Buffer.byteLength(JSON.stringify(payload)) > 32768)
			throw new Error("Event payload exceeds budget");
		await tx.insert(activityEvents).values({
			id: payload.id,
			event,
			groupId: "groupId" in payload.data ? payload.data.groupId : null,
			requiredGroupIds,
			requiresAllGroups: authority.requiresAllGroups ?? false,
			global: !scoped || (event === "validation.failed" && licenseId == null),
			payload,
			resourceType: resource.type,
			resourceId: resource.id,
			resourceRevision: version.revision,
			createdAt: now,
		});
		return payload;
	}
}
