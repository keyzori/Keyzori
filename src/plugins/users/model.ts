import { t } from "elysia";
import { httpModel } from "../../core/http/model";

const publicResource = t.Object(
	{
		id: httpModel.id,
		name: httpModel.name,
		enabled: t.Boolean(),
		metadata: httpModel.metadata,
		createdAt: t.String({ format: "date-time" }),
		updatedAt: t.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
const resource = t.Object(
	{
		...publicResource.properties,
		notes: httpModel.notes,
		disabledReason: t.Union([t.String(), t.Null()]),
		createdBy: t.String(),
		updatedBy: t.String(),
	},
	{ additionalProperties: false },
);
const create = t.Object(
	{
		name: httpModel.name,
		metadata: t.Optional(httpModel.metadata),
		notes: t.Optional(httpModel.notes),
	},
	{ additionalProperties: false },
);

export const userModel = {
	resource,
	publicResource,
	create,
	update: t.Object(
		{
			ids: httpModel.ids,
			changes: t.Partial(create),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	enable: t.Object(
		{ ids: httpModel.ids, reason: t.Optional(httpModel.reason) },
		{ additionalProperties: false },
	),
	disable: t.Object(
		{
			ids: httpModel.ids,
			reason: t.Optional(httpModel.reason),
			disabledReason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	remove: t.Object(
		{ ids: httpModel.ids, confirm: t.Literal(true), reason: httpModel.reason },
		{ additionalProperties: false },
	),
	query: t.Record(t.String(), t.String()),
	singleResponse: t.Object({ data: resource }, { additionalProperties: false }),
	bulkResponse: t.Object(
		{ data: t.Array(resource) },
		{ additionalProperties: false },
	),
	removeResponse: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	readResponse: t.Union([
		t.Object(
			{ data: t.Union([resource, publicResource]) },
			{ additionalProperties: false },
		),
		t.Object(
			{ data: t.Array(resource), nextCursor: t.Union([t.String(), t.Null()]) },
			{ additionalProperties: false },
		),
	]),
};
