import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const deliveryHistoryWebhook = (
	service: $Webhooks,
	requests: $Requests,
) =>
	guard(requests, "webhooks:read").get(
		"/webhooks/deliveries",
		{
			query: webhookModel.historyQuery,
			response: webhookModel.historyResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description: "Requires webhooks:read.",
			},
		},
		({ request, operation }) =>
			service.deliveryHistory(new URL(request.url).searchParams, operation),
	);
