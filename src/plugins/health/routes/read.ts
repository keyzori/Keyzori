import { Elysia, t } from "elysia";
import type { $Health } from "../../../types/application";

export const healthProperties = {
	healthy: t.Boolean(),
	postgresql: t.Boolean(),
	redis: t.Boolean(),
	version: t.String(),
	checkedAt: t.String({ format: "date-time" }),
	ageMs: t.Integer({ minimum: 0 }),
};

const responseModel = t.Object(
	{
		...healthProperties,
	},
	{ additionalProperties: false },
);

export const readHealth = (service: $Health) =>
	new Elysia({ normalize: false }).get(
		"/health",
		{
			response: { 200: responseModel, 503: responseModel },
			detail: { tags: ["Operations"], security: [] },
		},
		async ({ set }) => {
			const result = await service.status();
			if (!result.healthy) set.status = 503;
			return result;
		},
	);
