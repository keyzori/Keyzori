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
					"Stage a replacement signing key and disclose its secret once. Provision the receiver, then call activate-secret with this key ID. Staging alone does not affect delivery.",
			},
		},
		({ body, operation }) => service.rotateSecret(body, operation),
	);
