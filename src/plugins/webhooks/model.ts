import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { webhookEvents } from "./events";

const subscriptions = t.Array(t.UnionEnum(["*", ...webhookEvents]), {
	minItems: 1,
	maxItems: webhookEvents.length,
	uniqueItems: true,
});
const groupIds = t.Array(httpModel.id, { maxItems: 100, uniqueItems: true });
const create = t.Object(
	{
		url: t.String({ minLength: 1, maxLength: 2048 }),
		events: subscriptions,
		allGroups: t.Optional(t.Boolean()),
		groupIds: t.Optional(groupIds),
	},
	{ additionalProperties: false },
);
const resource = t.Object(
	{
		id: httpModel.id,
		url: t.String(),
		events: t.Array(t.UnionEnum(webhookEvents)),
		enabled: t.Boolean(),
		allGroups: t.Boolean(),
		groupIds,
		signingKeyId: httpModel.id,
		version: t.Integer(),
		lastError: t.Union([t.String(), t.Null()]),
		createdBy: t.String(),
		updatedBy: t.String(),
		createdAt: t.String(),
		updatedAt: t.String(),
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
		replayOf: t.Union([httpModel.id, t.Null()]),
		event: t.UnionEnum(webhookEvents),
		state,
		attempts: t.Integer(),
		attemptedAt: t.Union([t.String(), t.Null()]),
		nextAttemptAt: t.String(),
		expiresAt: t.String(),
		status: t.Union([t.Integer(), t.Null()]),
		error: t.Union([t.String(), t.Null()]),
		createdAt: t.String(),
	},
	{ additionalProperties: false },
);
const action = t.Object(
	{ ids: httpModel.ids, reason: t.Optional(httpModel.reason) },
	{ additionalProperties: false },
);
const query = {
	limit: t.Optional(t.String({ pattern: "^([1-9]|[1-9][0-9]|100)$" })),
	direction: t.Optional(t.UnionEnum(["asc", "desc"])),
	cursor: t.Optional(t.String({ maxLength: 4096 })),
	createdBefore: t.Optional(t.String({ format: "date-time" })),
	createdAfter: t.Optional(t.String({ format: "date-time" })),
};
const listResponse = <T extends typeof resource | typeof delivery>(item: T) =>
	t.Object(
		{
			data: t.Array(item),
			nextCursor: t.Union([t.String(), t.Null()]),
			pageLimit: t.Integer({ minimum: 1, maximum: 100 }),
		},
		{ additionalProperties: false },
	);
export const webhookModel = {
	resource,
	delivery,
	id: t.Object({ id: httpModel.id }, { additionalProperties: false }),
	detailQuery: t.Object({}, { additionalProperties: false }),
	detailResponse: t.Object({ data: resource }, { additionalProperties: false }),
	listResponse: listResponse(resource),
	historyDetailResponse: t.Object(
		{ data: delivery },
		{ additionalProperties: false },
	),
	historyListResponse: listResponse(delivery),
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
	rotateSecret: action,
	recovery: t.Object(
		{ ids: httpModel.ids, confirm: t.Literal(true), reason: httpModel.reason },
		{ additionalProperties: false },
	),
	recoveryResponse: t.Object(
		{ data: t.Array(delivery) },
		{ additionalProperties: false },
	),
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
	singleResponse: t.Object(
		{ data: resource, secret: t.String() },
		{ additionalProperties: false },
	),
	bulkResponse: t.Object(
		{ data: t.Array(resource) },
		{ additionalProperties: false },
	),
	rotatedResponse: t.Object(
		{
			data: t.Array(
				t.Object(
					{ id: httpModel.id, signingKeyId: httpModel.id, secret: t.String() },
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	deleteResponse: t.Object(
		{ data: t.Object({ ids: httpModel.ids }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
};
