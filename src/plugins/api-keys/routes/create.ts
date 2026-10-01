import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const createApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").post(
		"/api-keys",
		{
			body: apiKeyModel.create,
			response: apiKeyModel.issued,
			detail: {
				tags: ["ApiKey"],
				summary: "create api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
