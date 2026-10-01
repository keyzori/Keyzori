import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const deleteWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:delete").delete(
		"/webhooks",
		{
			body: webhookModel.delete,
			response: webhookModel.deleteResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:delete.",
			},
		},
		({ body, operation }) => service.delete(body, operation),
	);
