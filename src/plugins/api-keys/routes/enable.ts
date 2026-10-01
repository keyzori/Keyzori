import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const enableApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").post(
		"/api-keys/enable",
		{
			body: apiKeyModel.action,
			response: apiKeyModel.result,
			detail: {
				tags: ["ApiKey"],
				summary: "enable api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
