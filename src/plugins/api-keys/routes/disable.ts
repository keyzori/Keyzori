import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const disableApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").post(
		"/api-keys/disable",
		{
			body: apiKeyModel.action,
			response: apiKeyModel.result,
			detail: {
				tags: ["ApiKey"],
				summary: "disable api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
