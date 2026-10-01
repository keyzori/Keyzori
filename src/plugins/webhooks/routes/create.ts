import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const createWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:create").post(
		"/webhooks",
		{
			body: webhookModel.create,
			response: webhookModel.singleResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:create.",
			},
		},
		({ body, operation }) => service.create(body, operation),
	);
