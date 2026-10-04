import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const enableWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:enable").post(
		"/webhooks/enable",
		{
			body: webhookModel.enable,
			response: webhookModel.bulkResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:enable.",
			},
		},
		({ body, operation }) => service.enable(body, operation),
	);
