import { t } from "elysia";

const schedule = t.Object(
	{
		interval: t.UnionEnum(["day", "week", "month", "year"]),
		time: t.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }),
		timezone: t.String({ minLength: 1, maxLength: 128 }),
		dayOfWeek: t.Optional(t.Integer({ minimum: 1, maximum: 7 })),
		day: t.Optional(t.Integer({ minimum: 1, maximum: 31 })),
		month: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
	},
	{ additionalProperties: false },
);

const definition = t.Object(
	{
		name: t.String({ minLength: 1, maxLength: 128 }),
		limit: t.Number({ minimum: 0, maximum: 999999999999999 }),
		allowOverage: t.Optional(t.Boolean()),
		numericMode: t.Optional(t.UnionEnum(["integer", "decimal"])),
		precision: t.Optional(t.Integer({ minimum: 0, maximum: 6 })),
		schedule: t.Optional(t.Union([schedule, t.Null()])),
	},
	{ additionalProperties: false },
);

export const meterModel = {
	schedule,
	definition,
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
