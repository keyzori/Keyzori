import Elysia from "elysia";
import { StripeWebhookSignatureError } from "./StripeGateway";
import type { StripeWebhookService } from "./StripeWebhookService";

export interface StripeWebhookPluginOptions {
	/** Wake the durable worker after enqueueing; polling remains the fallback. */
	onWorkAvailable?: () => void | Promise<void>;
}

export function createStripeWebhookPlugin(
	service: StripeWebhookService,
	options: StripeWebhookPluginOptions = {},
) {
	return new Elysia({ name: "keyzori-stripe-webhook" }).post(
		"/webhooks/stripe",
		async ({ request, set }) => {
			const signature = request.headers.get("stripe-signature");
			if (!signature) {
				set.status = 400;
				return { received: false, error: "Missing Stripe signature." };
			}
			const rawPayload = new Uint8Array(await request.arrayBuffer());
			try {
				const receipt = await service.receive(rawPayload, signature);
				try {
					const wake = options.onWorkAvailable?.();
					if (wake) void wake.catch((error) => console.error(error));
				} catch (error) {
					console.error("Stripe webhook worker wakeup failed", error);
				}
				return {
					received: true,
					duplicate: !receipt.inserted,
					eventId: receipt.eventId,
				};
			} catch (error) {
				if (error instanceof StripeWebhookSignatureError) {
					set.status = 400;
					return { received: false, error: error.message };
				}
				set.status = 500;
				return { received: false, error: "Webhook could not be accepted." };
			}
		},
		{
			parse: "none",
			detail: {
				operationId: "receiveStripeWebhook",
				summary: "Receive a signed Stripe webhook",
			},
		},
	);
}
