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
		const scoped =
			event.startsWith("license.") ||
			event.startsWith("meter.") ||
			event.startsWith("group.") ||
			event === "usage.consumed" ||
			event === "validation.failed";
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
		const resource = this.resource(validated);
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

	private resource(
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
}
