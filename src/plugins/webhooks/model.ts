import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { webhookEvents } from "./events";

const subscriptions = t.Array(t.UnionEnum(["*", ...webhookEvents]), {
	minItems: 1,
	maxItems: webhookEvents.length,
	uniqueItems: true,
});
const create = t.Object(
	{ url: t.String({ minLength: 1, maxLength: 8192 }), events: subscriptions },
	{ additionalProperties: false },
);
const resource = t.Object(
	{
		id: httpModel.id,
		url: t.String(),
		events: subscriptions,
		enabled: t.Boolean(),
		createdBy: t.String(),
		updatedBy: t.String(),
		createdAt: t.String({ format: "date-time" }),
		updatedAt: t.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
const state = t.UnionEnum([
	"pending",
	"claimed",
	"succeeded",
	"failed",
	"cancelled",
]);
const delivery = t.Object(
	{
		id: httpModel.id,
		webhookId: httpModel.id,
		eventId: httpModel.id,
		event: t.UnionEnum(webhookEvents),
		state,
		attemptedAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
		status: t.Union([t.Integer(), t.Null()]),
		error: t.Union([t.String(), t.Null()]),
		createdAt: t.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
const action = t.Object(
	{ ids: httpModel.ids, reason: t.Optional(httpModel.reason) },
	{ additionalProperties: false },
);
const query = {
	id: t.Optional(httpModel.id),
	limit: t.Optional(t.String({ pattern: "^[1-9][0-9]*$" })),
	direction: t.Optional(t.UnionEnum(["asc", "desc"])),
	cursor: t.Optional(t.String()),
	search: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
	createdBefore: t.Optional(t.String({ format: "date-time" })),
	createdAfter: t.Optional(t.String({ format: "date-time" })),
};

export const webhookModel = {
	resource,
	delivery,
	create,
	update: t.Object(
		{
			ids: httpModel.ids,
			changes: t.Partial(create),
			reason: t.Optional(httpModel.reason),
		},
		{ additionalProperties: false },
	),
	enable: action,
	disable: action,
	delete: t.Object(
		{ ids: httpModel.ids, confirm: t.Literal(true), reason: httpModel.reason },
		{ additionalProperties: false },
	),
	query: t.Object(
		{
			...query,
			enabled: t.Optional(t.UnionEnum(["true", "false"])),
			sort: t.Optional(t.UnionEnum(["createdAt", "updatedAt"])),
		},
		{ additionalProperties: false },
	),
	historyQuery: t.Object(
		{
			...query,
			webhookId: t.Optional(httpModel.id),
			state: t.Optional(state),
			sort: t.Optional(t.Literal("createdAt")),
		},
		{ additionalProperties: false },
	),
	singleResponse: t.Object({ data: resource }, { additionalProperties: false }),
	bulkResponse: t.Object(
		{ data: t.Array(resource) },
		{ additionalProperties: false },
	),
	deleteResponse: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	readResponse: t.Union([
		t.Object({ data: resource }, { additionalProperties: false }),
		t.Object(
			{ data: t.Array(resource), nextCursor: t.Union([t.String(), t.Null()]) },
			{ additionalProperties: false },
		),
	]),
	historyResponse: t.Union([
		t.Object({ data: delivery }, { additionalProperties: false }),
		t.Object(
			{ data: t.Array(delivery), nextCursor: t.Union([t.String(), t.Null()]) },
			{ additionalProperties: false },
		),
	]),
};
