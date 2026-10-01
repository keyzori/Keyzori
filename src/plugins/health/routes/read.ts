import { Elysia, t } from "elysia";
import type { $Health } from "../../../types/application";

const responseModel = t.Object(
	{
		healthy: t.Boolean(),
		postgresql: t.Boolean(),
		redis: t.Boolean(),
		version: t.String(),
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
