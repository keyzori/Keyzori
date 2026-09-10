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
				query: pageQuery,
				response: linksResponse,
			})
			.post(
				"/links",
				({ body }) => service.link(body.licenseId, body.subscriptionId),
				{ body: linkBody, response: linkResponse },
			)
			.delete("/links/:id", ({ params }) => service.unlink(params.id), {
				response: linkResponse,
				params: idParams,
			})
			.post("/links/:id/sync", ({ params }) => service.sync(params.id), {
				response: linkResponse,
				params: idParams,
				body: emptyBody,
			})
			.get("/events", ({ query }) => service.events(query), {
				response: eventsResponse,
				query: eventQuery,
			})
			.post("/events/:id/retry", ({ params }) => service.retry(params.id), {
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
					response: receivedResponse,
					parse: "none",
					headers: webhookHeaders,
					detail: {
						summary:
							"Receive a signed Stripe webhook using unmodified request bytes",
					},
				},
			)
			.use(adminRoutes);
	}
}
