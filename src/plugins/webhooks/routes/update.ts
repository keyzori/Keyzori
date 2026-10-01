import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const updateWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:update").patch(
		"/webhooks",
		{
			body: webhookModel.update,
			response: webhookModel.bulkResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:update.",
			},
		},
		({ body, operation }) => service.update(body, operation),
	);
