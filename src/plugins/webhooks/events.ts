import { t } from "elysia";
import type { TSchema } from "typebox";
import { Assert } from "typebox/value";

export const webhookEvents = [
	"license.created",
	"license.updated",
	"license.enabled",
	"license.disabled",
	"license.deleted",
	"license.rotated",
	"license.group_detached",
	"license.group_attached",
	"user.created",
	"user.updated",
	"user.enabled",
	"user.disabled",
	"user.deleted",
	"group.created",
	"group.updated",
	"group.enabled",
	"group.disabled",
	"group.deleted",
	"license.hardware.registered",
	"license.hardware.removed",
	"license.ips.registered",
	"license.ips.removed",
	"usage.consumed",
	"meter.created",
	"meter.updated",
	"meter.deleted",
	"meter.adjusted",
	"api-key.created",
	"api-key.updated",
	"api-key.enabled",
	"api-key.disabled",
	"api-key.deleted",
	"api-key.rotated",
	"webhook.created",
	"webhook.updated",
	"webhook.enabled",
	"webhook.disabled",
	"webhook.deleted",
	"settings.updated",
	"meter.limit_reached",
	"meter.reset",
	"validation.failed",
] as const;

const id = t.String({ format: "uuid" });
const groupId = t.Union([id, t.Null()]);
/** Internal provenance, stored beside the payload and never delivered as event data. */
export const eventAuthoritySchema = t.Object(
	{
		requiredGroupIds: t.Optional(t.Array(id, { maxItems: 100 })),
		requiresAllGroups: t.Optional(t.Boolean()),
	},
	{ additionalProperties: false },
);
const decimal = t.String({
	pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$",
	maxLength: 32,
});
const license = t.Object(
	{ licenseId: id, groupId },
	{ additionalProperties: false },
);
const group = t.Object({ groupId: id }, { additionalProperties: false });
const user = t.Object({ userId: id }, { additionalProperties: false });
const apiKey = t.Object({ apiKeyId: id }, { additionalProperties: false });
const webhook = t.Object({ webhookId: id }, { additionalProperties: false });
const meterFields = {
	licenseId: id,
	groupId,
	counterId: id,
	meter: t.String({ minLength: 1, maxLength: 128 }),
	definitionRevision: t.Integer({ minimum: 1 }),
	resetGeneration: t.Integer({ minimum: 0 }),
	periodId: t.String({ minLength: 1, maxLength: 128 }),
	periodStartedAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
	periodEndsAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
	value: decimal,
	limit: t.Union([decimal, t.Null()]),
};
const meter = t.Object(meterFields, { additionalProperties: false });
export const eventResourceSchema = t.Object(
	{
		type: t.UnionEnum([
			"license",
			"group",
			"user",
			"api-key",
			"webhook",
			"settings",
			"validation",
		]),
		id: t.String({ minLength: 1, maxLength: 128 }),
		revision: t.String({ pattern: "^[1-9][0-9]{0,18}$" }),
	},
	{ additionalProperties: false },
);

function contract<const Name extends string, const Data extends TSchema>(
	event: Name,
	data: Data,
	scope: string,
) {
	const fields = {
		schemaVersion: t.Literal(1),
		id,
		event: t.Literal(event),
		createdAt: t.String({ format: "date-time" }),
		resource: eventResourceSchema,
		data,
	};
	return {
		scope,
		data,
		schema: t.Object(fields, { additionalProperties: false }),
		published: t.Object(
			{
				...fields,
				sequence: t.String({ pattern: "^[1-9][0-9]{0,18}$" }),
				epoch: id,
			},
			{ additionalProperties: false },
		),
	};
}

/** One registry supplies runtime validation, discriminated types and authority. */
export const eventContracts = {
	"license.created": contract("license.created", license, "licenses:read"),
	"license.updated": contract("license.updated", license, "licenses:read"),
	"license.enabled": contract("license.enabled", license, "licenses:read"),
	"license.disabled": contract("license.disabled", license, "licenses:read"),
	"license.deleted": contract("license.deleted", license, "licenses:read"),
	"license.rotated": contract("license.rotated", license, "licenses:read"),
	// The opposite group's identity and the previous resource state are never included.
	"license.group_detached": contract(
		"license.group_detached",
		license,
		"licenses:read",
	),
	"license.group_attached": contract(
		"license.group_attached",
		license,
		"licenses:read",
	),
	"user.created": contract("user.created", user, "users:read"),
	"user.updated": contract("user.updated", user, "users:read"),
	"user.enabled": contract("user.enabled", user, "users:read"),
	"user.disabled": contract("user.disabled", user, "users:read"),
	"user.deleted": contract("user.deleted", user, "users:read"),
	"group.created": contract("group.created", group, "groups:read"),
	"group.updated": contract("group.updated", group, "groups:read"),
	"group.enabled": contract("group.enabled", group, "groups:read"),
	"group.disabled": contract("group.disabled", group, "groups:read"),
	"group.deleted": contract("group.deleted", group, "groups:read"),
	"license.hardware.registered": contract(
		"license.hardware.registered",
		license,
		"devices:read",
	),
	"license.hardware.removed": contract(
		"license.hardware.removed",
		license,
		"devices:read",
	),
	"license.ips.registered": contract(
		"license.ips.registered",
		license,
		"ips:read",
	),
	"license.ips.removed": contract("license.ips.removed", license, "ips:read"),
	"usage.consumed": contract(
		"usage.consumed",
		t.Object(
			{ licenseId: id, groupId, operationId: id },
			{ additionalProperties: false },
		),
		"usage:read",
	),
	"meter.created": contract("meter.created", meter, "usage:read"),
	"meter.updated": contract("meter.updated", meter, "usage:read"),
	"meter.deleted": contract("meter.deleted", meter, "usage:read"),
	"meter.adjusted": contract("meter.adjusted", meter, "usage:read"),
	"meter.reset": contract("meter.reset", meter, "usage:read"),
	"meter.limit_reached": contract(
		"meter.limit_reached",
		t.Object(
			{ ...meterFields, limit: decimal },
			{ additionalProperties: false },
		),
		"usage:read",
	),
	"api-key.created": contract("api-key.created", apiKey, "root"),
	"api-key.updated": contract("api-key.updated", apiKey, "root"),
	"api-key.enabled": contract("api-key.enabled", apiKey, "root"),
	"api-key.disabled": contract("api-key.disabled", apiKey, "root"),
	"api-key.deleted": contract("api-key.deleted", apiKey, "root"),
	"api-key.rotated": contract("api-key.rotated", apiKey, "root"),
	// Control-plane lifecycle history includes deleted/foreign endpoint identities.
	// Only the environment operator has authority over the entire endpoint namespace.
	"webhook.created": contract("webhook.created", webhook, "root"),
	"webhook.updated": contract("webhook.updated", webhook, "root"),
	"webhook.enabled": contract("webhook.enabled", webhook, "root"),
	"webhook.disabled": contract("webhook.disabled", webhook, "root"),
	"webhook.deleted": contract("webhook.deleted", webhook, "root"),
	"settings.updated": contract(
		"settings.updated",
		t.Object({}, { additionalProperties: false }),
		"root",
	),
	"validation.failed": contract(
		"validation.failed",
		t.Object(
			{
				licenseId: t.Union([id, t.Null()]),
				groupId,
				code: t.String({ minLength: 1, maxLength: 128 }),
			},
			{ additionalProperties: false },
		),
		"licenses:read",
	),
} satisfies Record<
	(typeof webhookEvents)[number],
	{ scope: string; data: TSchema; schema: TSchema; published: TSchema }
>;

// TypeBox's union requires a tuple (an array inferred by .map becomes TNever).
// Keep both the runtime discriminator and TypeScript's narrowing intact.
export const eventEnvelopeSchema = t.Union([
	eventContracts["license.created"].schema,
	eventContracts["license.updated"].schema,
	eventContracts["license.enabled"].schema,
	eventContracts["license.disabled"].schema,
	eventContracts["license.deleted"].schema,
	eventContracts["license.rotated"].schema,
	eventContracts["license.group_detached"].schema,
	eventContracts["license.group_attached"].schema,
	eventContracts["user.created"].schema,
	eventContracts["user.updated"].schema,
	eventContracts["user.enabled"].schema,
	eventContracts["user.disabled"].schema,
	eventContracts["user.deleted"].schema,
	eventContracts["group.created"].schema,
	eventContracts["group.updated"].schema,
	eventContracts["group.enabled"].schema,
	eventContracts["group.disabled"].schema,
	eventContracts["group.deleted"].schema,
	eventContracts["license.hardware.registered"].schema,
	eventContracts["license.hardware.removed"].schema,
	eventContracts["license.ips.registered"].schema,
	eventContracts["license.ips.removed"].schema,
	eventContracts["usage.consumed"].schema,
	eventContracts["meter.created"].schema,
	eventContracts["meter.updated"].schema,
	eventContracts["meter.deleted"].schema,
	eventContracts["meter.adjusted"].schema,
	eventContracts["meter.reset"].schema,
	eventContracts["meter.limit_reached"].schema,
	eventContracts["api-key.created"].schema,
	eventContracts["api-key.updated"].schema,
	eventContracts["api-key.enabled"].schema,
	eventContracts["api-key.disabled"].schema,
	eventContracts["api-key.deleted"].schema,
	eventContracts["api-key.rotated"].schema,
	eventContracts["webhook.created"].schema,
	eventContracts["webhook.updated"].schema,
	eventContracts["webhook.enabled"].schema,
	eventContracts["webhook.disabled"].schema,
	eventContracts["webhook.deleted"].schema,
	eventContracts["settings.updated"].schema,
	eventContracts["validation.failed"].schema,
]);
export const publishedEventSchema = t.Union([
	eventContracts["license.created"].published,
	eventContracts["license.updated"].published,
	eventContracts["license.enabled"].published,
	eventContracts["license.disabled"].published,
	eventContracts["license.deleted"].published,
	eventContracts["license.rotated"].published,
	eventContracts["license.group_detached"].published,
	eventContracts["license.group_attached"].published,
	eventContracts["user.created"].published,
	eventContracts["user.updated"].published,
	eventContracts["user.enabled"].published,
	eventContracts["user.disabled"].published,
	eventContracts["user.deleted"].published,
	eventContracts["group.created"].published,
	eventContracts["group.updated"].published,
	eventContracts["group.enabled"].published,
	eventContracts["group.disabled"].published,
	eventContracts["group.deleted"].published,
	eventContracts["license.hardware.registered"].published,
	eventContracts["license.hardware.removed"].published,
	eventContracts["license.ips.registered"].published,
	eventContracts["license.ips.removed"].published,
	eventContracts["usage.consumed"].published,
	eventContracts["meter.created"].published,
	eventContracts["meter.updated"].published,
	eventContracts["meter.deleted"].published,
	eventContracts["meter.adjusted"].published,
	eventContracts["meter.reset"].published,
	eventContracts["meter.limit_reached"].published,
	eventContracts["api-key.created"].published,
	eventContracts["api-key.updated"].published,
	eventContracts["api-key.enabled"].published,
	eventContracts["api-key.disabled"].published,
	eventContracts["api-key.deleted"].published,
	eventContracts["api-key.rotated"].published,
	eventContracts["webhook.created"].published,
	eventContracts["webhook.updated"].published,
	eventContracts["webhook.enabled"].published,
	eventContracts["webhook.disabled"].published,
	eventContracts["webhook.deleted"].published,
	eventContracts["settings.updated"].published,
	eventContracts["validation.failed"].published,
]);

/** Never trust persisted JSON merely because its database column has a TS type. */
export function readEventEnvelope(value: unknown) {
	Assert(eventEnvelopeSchema, value);
	return value;
}
