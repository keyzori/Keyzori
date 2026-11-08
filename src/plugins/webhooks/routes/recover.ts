import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const recoverWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:recover").post(
		"/webhooks/recover",
		{
			body: webhookModel.recovery,
			response: webhookModel.recoveryResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description:
					"Make pending deliveries or expired claims due now, preserving delivery IDs, signing keys and the original eight-attempt/24-hour budget. Active claims cannot be stolen. Requires Idempotency-Key. An interrupted send may already have been processed.",
			},
		},
		({ body, operation }) => service.recover(body, operation),
	);
