import { t } from "elysia";
import { httpModel } from "../../core/http/model";
import { publishedEventSchema } from "../webhooks/events";

const nullableText = t.Union([t.String(), t.Null()]);
export const activityCursorSchema = t.String({
	minLength: 1,
	maxLength: 512,
	pattern: "^[A-Za-z0-9_-]+$",
});
const position = t.String({ pattern: "^(0|[1-9][0-9]{0,18})$" });
const protocol = t.Literal("invalidation-refetch");
const consistency = t.Literal("non-atomic");
export const activityWatermarkSchema = t.Object(
	{
		protocol,
		stateConsistency: consistency,
		epoch: httpModel.id,
		sequence: position,
		retainedAfter: position,
		cursor: activityCursorSchema,
	},
	{ additionalProperties: false },
);

export const activitySubscribeSchema = t.Object(
	{
		type: t.Literal("subscribe"),
		cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
	},
	{ additionalProperties: false },
);
export const activityServerFrameSchema = t.Union([
	t.Object(
		{
			type: t.Literal("ready"),
			schemaVersion: t.Literal(1),
			protocol,
			stateConsistency: consistency,
			resync: t.Literal("/events/watermark"),
			sessionExpiresAt: t.String({ format: "date-time" }),
			watermark: activityWatermarkSchema,
		},
		{ additionalProperties: false },
	),
	t.Object(
		{
			type: t.Literal("events"),
			data: t.Array(publishedEventSchema, { maxItems: 100 }),
			cursor: activityCursorSchema,
			hasMore: t.Boolean(),
		},
		{ additionalProperties: false },
	),
	t.Object(
		{
			type: t.Literal("error"),
			code: t.Literal("CURSOR_EXPIRED"),
			resync: t.Literal("/events/watermark"),
		},
		{ additionalProperties: false },
	),
	t.Object(
		{
			type: t.Literal("error"),
			code: t.UnionEnum([
				"UNAUTHORIZED",
				"FORBIDDEN",
				"INVALID_REQUEST",
				"SERVICE_UNAVAILABLE",
				"INTERNAL_ERROR",
			]),
		},
		{ additionalProperties: false },
	),
]);
export const activityModel = {
	event: publishedEventSchema,
	watermark: activityWatermarkSchema,
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
