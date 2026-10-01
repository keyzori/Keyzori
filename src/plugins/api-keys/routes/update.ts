import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const updateApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").patch(
		"/api-keys",
		{
			body: apiKeyModel.update,
			response: apiKeyModel.result,
			detail: {
				tags: ["ApiKey"],
				summary: "update api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
