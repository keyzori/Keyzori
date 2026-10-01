import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { securityModel } from "../../core/security/model";
import { meterModel } from "./meterModel";

const fields = {
	userId: t.Optional(t.Union([httpModel.id, t.Null()])),
	itemId: t.Optional(t.Union([httpModel.id, t.Null()])),
	expiresAt: t.Optional(httpModel.expiresAt),
	deviceLimit: t.Optional(
		t.Union([t.Integer({ minimum: 0, maximum: 2147483647 }), t.Null()]),
	),
	ipLimit: t.Optional(
		t.Union([t.Integer({ minimum: 0, maximum: 2147483647 }), t.Null()]),
	),
	allowedIps: t.Optional(
		t.Array(t.String({ minLength: 1, maxLength: 64 }), {
			maxItems: 256,
			uniqueItems: true,
		}),
	),
	metadata: t.Optional(httpModel.metadata),
	notes: t.Optional(httpModel.notes),
	meters: t.Optional(meterModel.changes),
};

const meter = t.Object(
	{
		name: t.String(),
		value: t.String(),
		limit: t.String(),
		allowOverage: t.Boolean(),
		numericMode: t.UnionEnum(["integer", "decimal"]),
		precision: t.Integer(),
		schedule: t.Union([meterModel.schedule, t.Null()]),
		nextResetAt: httpModel.expiresAt,
		lastScheduledResetAt: httpModel.expiresAt,
		lastResetAt: httpModel.expiresAt,
	},
	{ additionalProperties: false },
);
const safeFields = {
	id: httpModel.id,
	enabled: t.Boolean(),
	userId: t.Union([httpModel.id, t.Null()]),
	itemId: t.Union([httpModel.id, t.Null()]),
	expiresAt: httpModel.expiresAt,
	deviceLimit: t.Union([t.Integer(), t.Null()]),
	ipLimit: t.Union([t.Integer(), t.Null()]),
	allowedIps: t.Array(t.String()),
	metadata: httpModel.metadata,
	meters: t.Array(meter),
	createdAt: t.String(),
	updatedAt: t.String(),
};
const safe = t.Object(safeFields, { additionalProperties: false });
const admin = t.Object(
	{
		...safeFields,
		disabledReason: t.Union([t.String(), t.Null()]),
		notes: httpModel.notes,
		keyFormat: securityModel.keyFormat,
		createdBy: t.String(),
		updatedBy: t.String(),
		hardwareIds: t.Array(t.String()),
		registeredIps: t.Array(t.String()),
	},
	{ additionalProperties: false },
);

export const licenseModel = {
	create: t.Object(fields, { additionalProperties: false }),
	update: t.Object(
		{
			ids: httpModel.ids,
			changes: t.Object(fields, { additionalProperties: false }),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	action: t.Object(
		{ ids: httpModel.ids, reason: t.Optional(httpModel.reason) },
		{ additionalProperties: false },
	),
	rotate: t.Object(
		{
			ids: httpModel.ids,
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	delete: t.Object(
		{ ids: httpModel.ids, confirm: t.Literal(true), reason: httpModel.reason },
		{ additionalProperties: false },
	),
	adjust: t.Object(
		{
			ids: httpModel.ids,
			name: t.String({ minLength: 1, maxLength: 128 }),
			action: t.UnionEnum(["set", "increment", "decrement", "reset"]),
			value: t.Optional(t.Number({ minimum: 0, maximum: 999999999999999 })),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	removeHardware: t.Object(
		{
			ids: httpModel.ids,
			hardwareIds: t.Array(t.String({ minLength: 1, maxLength: 512 }), {
				minItems: 1,
				uniqueItems: true,
			}),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	removeIps: t.Object(
		{
			ids: httpModel.ids,
			ips: t.Array(t.String({ minLength: 1, maxLength: 64 }), {
				minItems: 1,
				uniqueItems: true,
			}),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	result: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	safe: t.Object({ data: safe }, { additionalProperties: false }),
	read: t.Union([
		t.Object({ data: admin }, { additionalProperties: false }),
		t.Object({ data: safe }, { additionalProperties: false }),
		t.Object(
			{ data: t.Array(admin), nextCursor: t.Union([t.String(), t.Null()]) },
			{ additionalProperties: false },
		),
	]),
	issued: t.Object(
		{ data: admin, credential: t.String() },
		{ additionalProperties: false },
	),
	rotated: t.Object(
		{
			data: t.Array(
				t.Object(
					{ id: httpModel.id, credential: t.String() },
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
};
