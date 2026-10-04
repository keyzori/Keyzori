import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const disableWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:disable").post(
		"/webhooks/disable",
		{
			body: webhookModel.disable,
			response: webhookModel.bulkResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:disable.",
			},
		},
		({ body, operation }) => service.disable(body, operation),
	);
