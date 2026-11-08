import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import {
	eventContracts,
	eventEnvelopeSchema,
	publishedEventSchema,
	readEventEnvelope,
	webhookEvents,
} from "../../plugins/webhooks/events";
import {
	eventScope,
	allowsHistoricalGroups,
} from "../../core/auth/EventAuthorization";
import type { $Principal } from "../../types/auth";

const licenseId = Bun.randomUUIDv7();
const base = {
	schemaVersion: 1,
	id: Bun.randomUUIDv7(),
	createdAt: new Date().toISOString(),
	resource: { type: "license", id: licenseId, revision: "1" },
};

test("every advertised event has exactly one versioned runtime discriminator and explicit authority", () => {
	expect(
		eventEnvelopeSchema.anyOf
			.map((schema) => schema.properties.event.const)
			.sort(),
	).toEqual([...webhookEvents].sort());
	expect(
		publishedEventSchema.anyOf
			.map((schema) => schema.properties.event.const)
			.sort(),
	).toEqual([...webhookEvents].sort());
	for (const event of webhookEvents)
		expect(eventScope(event)).toBe(eventContracts[event].scope);
	expect(eventScope("license.future-secret")).toBeUndefined();
	expect(eventScope("toString")).toBeUndefined();
});

test("the discriminator requires its own data and forbids cross-family fields and secrets", () => {
	const event = {
		...base,
		event: "license.created",
		data: { licenseId, groupId: null },
	};
	expect(JSON.stringify(readEventEnvelope(event))).toBe(JSON.stringify(event));
	for (const invalid of [
		{ ...event, data: {} },
		{ ...event, data: { userId: licenseId } },
		{ ...event, event: "user.created" },
		{ ...event, schemaVersion: 2 },
		{ ...event, resource: { ...base.resource, revision: "0" } },
		{ ...event, data: { ...event.data, credential: "secret" } },
		{ ...event, data: { ...event.data, clientIp: "192.0.2.1" } },
	])
		expect(() => readEventEnvelope(invalid)).toThrow();
});

test("transfer notifications cannot carry the other group's identity or historical state", () => {
	for (const event of ["license.group_detached", "license.group_attached"]) {
		const value = { ...base, event, data: { licenseId, groupId: null } };
		expect(Check(eventEnvelopeSchema, value)).toBe(true);
		expect(
			Check(eventEnvelopeSchema, {
				...value,
				data: { ...value.data, sourceGroupId: Bun.randomUUIDv7() },
			}),
		).toBe(false);
		expect(
			Check(eventEnvelopeSchema, {
				...value,
				data: { ...value.data, before: { metadata: "private" } },
			}),
		).toBe(false);
	}
});

test("counter events require durable identity and exact values; reaching a limit cannot mean unlimited", () => {
	const data = {
		licenseId,
		groupId: null,
		counterId: Bun.randomUUIDv7(),
		meter: "requests",
		definitionRevision: 2,
		resetGeneration: 1,
		periodId: "lifetime",
		periodStartedAt: null,
		periodEndsAt: null,
		value: "0.125",
		limit: "1.000",
	};
	expect(
		Check(eventEnvelopeSchema, { ...base, event: "meter.adjusted", data }),
	).toBe(true);
	expect(
		Check(eventEnvelopeSchema, {
			...base,
			event: "meter.limit_reached",
			data: { ...data, limit: null },
		}),
	).toBe(false);
	expect(
		Check(eventEnvelopeSchema, {
			...base,
			event: "meter.adjusted",
			data: { ...data, value: 0.125 },
		}),
	).toBe(false);
	const { counterId: _id, ...missingIdentity } = data;
	expect(
		Check(eventEnvelopeSchema, {
			...base,
			event: "meter.deleted",
			data: missingIdentity,
		}),
	).toBe(false);
});

test("historical group checks require every provenance group and respect ungrouped authority", () => {
	const a = Bun.randomUUIDv7();
	const b = Bun.randomUUIDv7();
	const principal: $Principal = {
		kind: "api",
		id: Bun.randomUUIDv7(),
		name: "Scoped",
		scopes: [],
		credentialHash: "fixture",
		groupIds: [b],
		allGroups: false,
	};
	expect(allowsHistoricalGroups(principal, {})).toBe(true);
	expect(allowsHistoricalGroups(principal, { requiredGroupIds: [a, b] })).toBe(
		false,
	);
	expect(
		allowsHistoricalGroups(
			{ ...principal, groupIds: [a, b] },
			{ requiredGroupIds: [a.toUpperCase(), b] },
		),
	).toBe(true);
	expect(
		allowsHistoricalGroups(
			{ ...principal, groupIds: [a, b] },
			{ requiresAllGroups: true },
		),
	).toBe(false);
	expect(
		allowsHistoricalGroups(
			{ ...principal, allGroups: true },
			{ requiredGroupIds: [a, b], requiresAllGroups: true },
		),
	).toBe(true);
});
