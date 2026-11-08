import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { publishedEventSchema } from "../webhooks/events";

const nullableText = t.Union([t.String(), t.Null()]);
export const activitySubscribeSchema = t.Object(
	{
		type: t.Literal("subscribe"),
		cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
	},
	{ additionalProperties: false },
);
export const activityModel = {
	event: publishedEventSchema,
	watermark: t.Object(
		{
			protocol: t.Literal("invalidation-refetch"),
			stateConsistency: t.Literal("non-atomic"),
			epoch: httpModel.id,
			sequence: t.String({ pattern: "^(0|[1-9][0-9]{0,18})$" }),
			retainedAfter: t.String({ pattern: "^(0|[1-9][0-9]{0,18})$" }),
			cursor: t.String({ maxLength: 512 }),
		},
		{ additionalProperties: false },
	),
	audit: t.Object(
		{
			id: httpModel.id,
			action: t.String(),
			actor: t.Object({
				kind: t.UnionEnum(["root", "api", "license", "system", "anonymous"]),
				id: nullableText,
				name: nullableText,
			}),
			targetType: t.String(),
			targetId: t.Union([httpModel.id, t.Null()]),
			groupId: t.Union([httpModel.id, t.Null()]),
			requiredGroupIds: t.Array(httpModel.id),
			requiresAllGroups: t.Boolean(),
			global: t.Boolean(),
			requestId: t.String(),
			clientIp: nullableText,
			hardwareId: nullableText,
			reason: nullableText,
			before: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
			after: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
			createdAt: t.String({ format: "date-time" }),
		},
		{ additionalProperties: false },
	),
};
