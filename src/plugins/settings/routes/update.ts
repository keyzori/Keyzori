import { t } from "elysia";
import { guard } from "../../../core/http/guard";
import { settingsModel } from "../model";
import type { $Requests, $Settings } from "../../../types/application";
import { httpModel } from "../../../core/http/model";

export const updateSettings = (service: $Settings, requests: $Requests) =>
	guard(requests, "root").patch(
		"/settings",
		{
			body: t.Object(
				{
					changes: settingsModel.changes,
					reason: t.Optional(httpModel.reason),
				},
				{ additionalProperties: false },
			),
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
		({ body, operation }) =>
			service.update(body.changes, operation.principal, operation, body.reason),
	);
