import { t } from "elysia";
import { httpModel } from "../../core/http/model";

const decimal = t.String({
	pattern: "^(0|[1-9][0-9]{0,14})(\\.[0-9]{1,6})?$",
});

const schedule = t.Object(
	{
		interval: t.UnionEnum(["day", "week", "month", "year"]),
		time: t.Optional(t.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })),
		timezone: t.Optional(
			t.String({ minLength: 1, maxLength: 128, default: "UTC" }),
		),
		dayOfWeek: t.Optional(t.Integer({ minimum: 1, maximum: 7 })),
		day: t.Optional(t.Integer({ minimum: 1, maximum: 31 })),
		month: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
		anchorAt: t.Optional(
			t.String({
				pattern:
					"^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?$",
				description:
					"Recurring local date/time in timezone (UTC by default), without an offset. Use instead of time/dayOfWeek/day/month. Recurs before and after this reference; month-end and leap-day clamping retain the original requested day.",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Half-open calendar periods using PostgreSQL DST gap/overlap resolution. Supply anchorAt, or time and the interval's calendar fields (ISO dayOfWeek for week; day for month; month and day for year).",
	},
);

const definition = t.Object(
	{
		name: t.String({ minLength: 1, maxLength: 128 }),
		limit: t.Optional(t.Union([decimal, t.Null()])),
		numericMode: t.Optional(t.UnionEnum(["integer", "decimal"])),
		precision: t.Optional(t.Integer({ minimum: 0, maximum: 6 })),
		schedule: t.Optional(t.Union([schedule, t.Null()])),
		startsAt: t.Optional(
			t.Union([
				t.String({
					format: "date-time",
					maxLength: 40,
					description:
						"Consumption is rejected before this instant and allowed at it. Independent of calendar resets and licence eligibility. Null means no consumption-start restriction.",
				}),
				t.Null(),
			]),
		),
	},
	{ additionalProperties: false },
);

const identity = {
	counterId: httpModel.id,
	definitionRevision: t.Integer({
		minimum: 1,
		description: "Advances on a changed definition; no-op edits retain it.",
	}),
	resetGeneration: t.Integer({
		minimum: 0,
		description:
			"Advances on every manual reset, including resetting a zero balance. Calendar resets change the period boundaries instead.",
	}),
	periodId: t.String({
		description:
			"Opaque identity for this counter, definition revision, manual-reset generation and calendar period (or lifetime when unscheduled).",
	}),
	periodStartedAt: httpModel.expiresAt,
	periodEndsAt: httpModel.expiresAt,
};

export const meterModel = {
	schedule,
	definition,
	resource: t.Object(
		{
			...identity,
			name: t.String(),
			value: decimal,
			limit: t.Union([decimal, t.Null()]),
			numericMode: t.UnionEnum(["integer", "decimal"]),
			precision: t.Integer({ minimum: 0, maximum: 6 }),
			startsAt: httpModel.expiresAt,
			schedule: t.Union([schedule, t.Null()]),
			nextResetAt: httpModel.expiresAt,
			lastScheduledResetAt: httpModel.expiresAt,
			lastResetAt: httpModel.expiresAt,
		},
		{ additionalProperties: false },
	),
	usageEntry: t.Object(
		{
			...identity,
			name: t.String(),
			delta: decimal,
			before: decimal,
			after: decimal,
			limit: t.Union([decimal, t.Null()]),
		},
		{ additionalProperties: false },
	),
	changes: t.Object(
		{
			upsert: t.Optional(t.Array(definition, { maxItems: 128 })),
			remove: t.Optional(
				t.Array(t.String({ minLength: 1, maxLength: 128 }), {
					maxItems: 128,
					uniqueItems: true,
				}),
			),
		},
		{ additionalProperties: false },
	),
};
