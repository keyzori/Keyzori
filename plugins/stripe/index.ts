import { Elysia } from "elysia";
import type { PluginContext } from "../../src/plugins/contract.ts";
import { emptyBody, idParams, pageQuery } from "../../src/shared/schemas.ts";
import { StripeConfig } from "./StripeConfig.ts";
import { StripeGateway } from "./StripeGateway.ts";
import { StripeRepository } from "./StripeRepository.ts";
import { StripeService } from "./StripeService.ts";
import { StripeWorker } from "./StripeWorker.ts";
import { eventQuery, linkBody, webhookHeaders } from "./schemas.ts";
import {
	linkResponse,
	linksResponse,
	eventsResponse,
	retryResponse,
	receivedResponse,
} from "./responses.ts";

export default class StripePlugin {
	readonly name = "stripe";
	create(context: PluginContext) {
		const config = new StripeConfig(context.env);
		const repository = new StripeRepository(context.database);
		const service = new StripeService(
			context,
			repository,
			new StripeGateway(config),
		);
		const worker = new StripeWorker(repository, service, context.logger);
		const adminRoutes = new Elysia({
			prefix: "/admin",
			detail: context.adminGuard.config.detail,
		})
			.use(context.adminGuard)
			.get("/links", ({ query }) => service.links(query), {
				detail: {
					tags: ["stripe"],
					operationId: "listStripeLinks",
					summary: "List subscription links",
					description:
						"Browse links between Keyzori licenses and existing Stripe subscriptions. Only available when the Stripe plugin is enabled.",
				},
				query: pageQuery,
				response: linksResponse,
			})
			.post(
				"/links",
				({ body }) => service.link(body.licenseId, body.subscriptionId),
				{
					detail: {
						tags: ["stripe"],
						operationId: "linkStripeSubscription",
						summary: "Link a subscription",
						description:
							"Link an existing Stripe subscription to a subscription license and immediately synchronize billing status and expiry. Does not create checkout or a customer portal. Unlink first to change an existing subscription.",
					},
					body: linkBody,
					response: linkResponse,
				},
			)
			.delete("/links/:id", ({ params }) => service.unlink(params.id), {
				detail: {
					tags: ["stripe"],
					operationId: "unlinkStripeSubscription",
					summary: "Unlink a subscription",
					description:
						"Remove the billing link for the license UUID in id and clear only the Stripe access block. Does not cancel the Stripe subscription or clear other access blocks.",
				},
				response: linkResponse,
				params: idParams,
			})
			.post("/links/:id/sync", ({ params }) => service.sync(params.id), {
				detail: {
					tags: ["stripe"],
					operationId: "syncStripeSubscription",
					summary: "Synchronize a subscription",
					description:
						"Fetch the latest Stripe subscription state for the license UUID in id, then update expiry and the Stripe access block. Send an empty JSON object.",
				},
				response: linkResponse,
				params: idParams,
				body: emptyBody,
			})
			.get("/events", ({ query }) => service.events(query), {
				detail: {
					tags: ["stripe"],
					operationId: "listStripeEvents",
					summary: "List webhook events",
					description:
						"Browse queued webhook events, optionally filtered by processing state. Webhooks are processed asynchronously.",
				},
				response: eventsResponse,
				query: eventQuery,
			})
			.post("/events/:id/retry", ({ params }) => service.retry(params.id), {
				detail: {
					tags: ["stripe"],
					operationId: "retryStripeEvent",
					summary: "Retry a webhook event",
					description:
						"Requeue an event using its internal event UUID, not the Stripe evt_ identifier. Send an empty JSON object.",
				},
				response: retryResponse,
				params: idParams,
				body: emptyBody,
			});
		return new Elysia({
			name: "keyzori-plugin-stripe",
			prefix: "/plugins/stripe",
		})
			.onStart(() => worker.start())
			.onStop(() => worker.stop())
			.post(
				"/webhook",
				async ({ request, headers }) =>
					service.webhook(
						new Uint8Array(await request.arrayBuffer()),
						headers["stripe-signature"],
					),
				{
					detail: {
						tags: ["stripe"],
						operationId: "receiveStripeWebhook",
						summary: "Receive a Stripe webhook",
						description:
							"Verify the Stripe-Signature header against the original, unmodified request bytes and enqueue the event for asynchronous processing. Duplicate Stripe event IDs are deduplicated. A successful response confirms receipt, not completed synchronization.",
						security: [],
					},
					response: receivedResponse,
					parse: "none",
					headers: webhookHeaders,
				},
			)
			.use(adminRoutes);
	}
}
