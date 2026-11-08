import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { securityModel } from "../../core/security/model";
import { meterModel } from "./meterModel";
import { groupModel } from "../groups/model";
import { userModel } from "../users/model";

const fields = {
	userId: t.Optional(t.Union([httpModel.id, t.Null()])),
	groupId: t.Optional(t.Union([httpModel.id, t.Null()])),
	expiresAt: t.Optional(httpModel.expiresAt),
	deviceLimit: t.Optional(
		t.Union([t.Integer({ minimum: 0, maximum: 1000 }), t.Null()]),
	),
	ipLimit: t.Optional(
		t.Union([t.Integer({ minimum: 0, maximum: 1000 }), t.Null()]),
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

const meter = meterModel.resource;
const fieldsView = {
	id: httpModel.id,
	enabled: t.Boolean(),
	userId: t.Union([httpModel.id, t.Null()]),
	groupId: t.Union([httpModel.id, t.Null()]),
	group: t.Union([groupModel.resource, t.Null()]),
	user: t.Union([userModel.resource, t.Null()]),
	expiresAt: httpModel.expiresAt,
	deviceLimit: t.Union([t.Integer(), t.Null()]),
	ipLimit: t.Union([t.Integer(), t.Null()]),
	allowedIps: t.Array(t.String()),
	metadata: httpModel.metadata,
	meters: t.Array(meter),
	createdAt: t.String(),
	updatedAt: t.String(),
};
const admin = t.Object(
	{
		...fieldsView,
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

const summary = t.Object(
	{
		id: httpModel.id,
		enabled: t.Boolean(),
		disabledReason: t.Union([t.String(), t.Null()]),
		groupId: t.Union([httpModel.id, t.Null()]),
		userId: t.Union([httpModel.id, t.Null()]),
		expiresAt: httpModel.expiresAt,
		createdAt: t.String(),
		updatedAt: t.String(),
	},
	{ additionalProperties: false },
);
const usageEntry = meterModel.usageEntry;
export const licenseModel = {
	resource: admin,
	receipt: t.Object(
		{
			data: t.Object(
				{
					id: httpModel.id,
					licenseId: httpModel.id,
					consumedAt: t.String({ format: "date-time" }),
					historical: t.Literal(true),
					outcome: t.Literal("accepted"),
					entries: t.Array(usageEntry),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	validation: t.Object(
		{
			...t.Omit(admin, ["notes", "group", "user"]).properties,
			group: t.Union([t.Omit(groupModel.resource, ["notes"]), t.Null()]),
			user: t.Union([t.Omit(userModel.resource, ["notes"]), t.Null()]),
		},
		{ additionalProperties: false },
	),
	meter,
	consume: t.Object(
		{
			licenseId: httpModel.id,
			expectedGroupId: t.Optional(t.Union([httpModel.id, t.Null()])),
			hardwareId: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
			usage: t.Record(
				t.String({ minLength: 1, maxLength: 128 }),
				t.String({ pattern: "^(0|[1-9][0-9]{0,14})(\\.[0-9]{1,6})?$" }),
				{ minProperties: 1, maxProperties: 128 },
			),
		},
		{ additionalProperties: false },
	),
	consumed: t.Object(
		{
			data: t.Object(
				{
					id: httpModel.id,
					licenseId: httpModel.id,
					consumedAt: t.String(),
					replayed: t.Boolean(),
					entries: t.Array(usageEntry),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	register: t.Object(
		{
			licenseId: httpModel.id,
			hardwareId: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
			ip: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
		},
		{ additionalProperties: false },
	),
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
			value: t.Optional(
				t.String({ pattern: "^(0|[1-9][0-9]{0,14})(\\.[0-9]{1,6})?$" }),
			),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	removeHardware: t.Object(
		{
			ids: httpModel.ids,
			hardwareIds: t.Array(t.String({ minLength: 1, maxLength: 512 }), {
				minItems: 1,
				maxItems: 100,
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
				maxItems: 100,
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
	read: t.Union([
		t.Object({ data: admin }, { additionalProperties: false }),
		t.Object(
			{
				data: t.Array(summary),
				nextCursor: t.Union([t.String(), t.Null()]),
				pageLimit: t.Integer({ minimum: 1, maximum: 100 }),
			},
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
