import { t } from "elysia";

export const securityModel = {
	keyFormat: t.Object(
		{
			prefix: t.String({ maxLength: 128 }),
			separator: t.String({ maxLength: 16 }),
			groups: t.Integer({ minimum: 1, maximum: 32 }),
			length: t.Integer({ minimum: 1, maximum: 128 }),
			charset: t.Union([
				t.Literal("uppercase"),
				t.Literal("lowercase"),
				t.Literal("alphanumeric"),
				t.Literal("hex"),
			]),
		},
		{ additionalProperties: false },
	),
};
