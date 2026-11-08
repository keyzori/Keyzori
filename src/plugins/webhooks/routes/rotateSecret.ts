import { guard } from "../../../core/http/guard";
import type { $Requests, $Webhooks } from "../../../types/application";
import { webhookModel } from "../model";

export const rotateWebhookSecret = (service: $Webhooks, requests: $Requests) =>
	guard(requests, "webhooks:rotate-secret").post(
		"/webhooks/rotate-secret",
		{
			body: webhookModel.rotateSecret,
			response: webhookModel.rotatedResponse,
			detail: {
				tags: ["Webhooks"],
				security: [{ bearerAuth: [] }],
				description:
					"Issue a signing secret once; queued deliveries keep their original signing key.",
			},
		},
		({ body, operation }) => service.rotateSecret(body, operation),
	);
