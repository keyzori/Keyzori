import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { scopes } from "../../core/auth/scopes";

const create = t.Object(
	{
		name: httpModel.name,
		scopes: t.Array(t.UnionEnum(scopes), { uniqueItems: true }),
		expiresAt: t.Optional(httpModel.expiresAt),
	},
	{ additionalProperties: false },
);
const view = t.Object(
	{
		id: httpModel.id,
		name: t.String(),
		scopes: t.Array(t.String()),
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
			changes: t.Partial(create),
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
			{ data: t.Array(view), nextCursor: t.Union([t.String(), t.Null()]) },
			{ additionalProperties: false },
		),
	]),
	result: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
};
