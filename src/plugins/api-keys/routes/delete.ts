import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const deleteApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").delete(
		"/api-keys",
		{
			body: apiKeyModel.delete,
			response: apiKeyModel.result,
			detail: {
				tags: ["ApiKey"],
				summary: "delete api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.delete(body, operation),
	);
