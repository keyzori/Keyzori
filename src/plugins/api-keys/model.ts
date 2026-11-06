import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { actions, scopes } from "../../core/auth/scopes";

const description = t.Union([t.String({ maxLength: 1024 }), t.Null()]);
const grantChanges = {
	scopes: t.Optional(
		t.Array(t.UnionEnum(scopes), {
			uniqueItems: true,
			maxItems: scopes.length,
		}),
	),
	allGroups: t.Optional(t.Boolean()),
	groupIds: t.Optional(
		t.Array(httpModel.id, { uniqueItems: true, maxItems: 100 }),
	),
};

const create = t.Object(
	{
		name: httpModel.name,
		description: t.Optional(description),
		expiresAt: t.Optional(httpModel.expiresAt),
	},
	{ additionalProperties: false },
);
const view = t.Object(
	{
		id: httpModel.id,
		name: t.String(),
		description,
		scopes: t.Array(t.UnionEnum(actions)),
		allGroups: t.Boolean(),
		groupIds: t.Array(httpModel.id),
		enabled: t.Boolean(),
		expiresAt: httpModel.expiresAt,
		lastUsedAt: httpModel.expiresAt,
		createdAt: t.String(),
		updatedAt: t.String(),
		createdBy: t.String(),
		updatedBy: t.String(),
	},
	{ additionalProperties: false },
);

export const apiKeyModel = {
	create,
	update: t.Object(
		{
			ids: httpModel.ids,
			changes: t.Object(
				{
					name: t.Optional(httpModel.name),
					description: t.Optional(description),
					expiresAt: t.Optional(httpModel.expiresAt),
					...grantChanges,
				},
				{ additionalProperties: false, minProperties: 1 },
			),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	action: t.Object(
		{ ids: httpModel.ids, reason: t.Optional(httpModel.reason) },
		{ additionalProperties: false },
	),
	delete: t.Object(
		{ ids: httpModel.ids, confirm: t.Literal(true), reason: httpModel.reason },
		{ additionalProperties: false },
	),
	issued: t.Object(
		{ data: view, credential: t.String() },
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
	read: t.Union([
		t.Object({ data: view }, { additionalProperties: false }),
		t.Object(
			{
				data: t.Array(view),
				nextCursor: t.Union([t.String(), t.Null()]),
				pageLimit: t.Integer({ minimum: 1, maximum: 100 }),
			},
			{ additionalProperties: false },
		),
	]),
	result: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
};
