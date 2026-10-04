import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const readWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:read").get(
		"/webhooks",
		{
			query: webhookModel.query,
			response: webhookModel.readResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:read.",
			},
		},
		({ request, operation }) =>
			service.read(new URL(request.url).searchParams, operation),
	);
