import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const activateWebhookSecret = (
	service: $Webhooks,
	requests: $Requests,
) =>
	guard(requests, "webhooks:rotate-secret").post(
		"/webhooks/activate-secret",
		{
			body: webhookModel.activateSecret,
			response: webhookModel.activatedResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description:
					"Activate the exact staged signing key after the receiver has installed it. Requires Idempotency-Key. Queued deliveries retain their signing snapshots.",
			},
		},
		({ body, operation }) => service.activateSecret(body, operation),
	);
