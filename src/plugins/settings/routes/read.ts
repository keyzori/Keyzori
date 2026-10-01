import { t } from "elysia";
import { guard } from "../../../core/http/guard";
import { settingsModel } from "../model";
import type { $Requests, $Settings } from "../../../types/application";

export const readSettings = (service: $Settings, requests: $Requests) =>
	guard(requests, "root").get(
		"/settings",
		{
			response: t.Object(
				{ data: settingsModel.value },
				{ additionalProperties: false },
			),
			detail: {
				tags: ["Settings"],
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		async ({ operation }) => ({
			data: await service.read(undefined, operation.deadlineAt),
		}),
	);
