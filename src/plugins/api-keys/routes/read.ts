import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const readApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").get(
		"/api-keys",
		{
			response: apiKeyModel.read,
			detail: {
				tags: ["ApiKey"],
				summary: "read api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ request, operation }) =>
			service.read(new URL(request.url).searchParams, operation),
	);
