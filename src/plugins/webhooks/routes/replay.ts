import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const replayWebhook = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:replay").post(
		"/webhooks/replay",
		{
			body: webhookModel.recovery,
			response: webhookModel.recoveryResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description:
					"Replay terminal deliveries to the currently authorized endpoint with new delivery IDs and the original event IDs. Requires Idempotency-Key. Receivers may already have processed these events; duplicate processing is possible.",
			},
		},
		({ body, operation }) => service.replay(body, operation),
	);
