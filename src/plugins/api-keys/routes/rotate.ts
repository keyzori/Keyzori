import type { $ApiKeys, $Requests } from "../../../types/application";
import { guard } from "../../../core/http/guard";
import { apiKeyModel } from "../model";

export const rotateApiKey = (service: $ApiKeys, requests: $Requests) =>
	guard(requests, "root").post(
		"/api-keys/rotate",
		{
			body: apiKeyModel.action,
			response: apiKeyModel.rotated,
			detail: {
				tags: ["ApiKey"],
				summary: "rotate api-keys",
				security: [{ bearerAuth: [] }],
				"x-required-scope": "root",
			},
		},
		({ body, operation }) => service.rotate(body, operation),
	);
