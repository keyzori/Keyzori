import { Elysia } from "elysia";
import type { $Requests, $Webhooks } from "../../types/application";
import { createWebhook } from "./routes/create";
import { readWebhook } from "./routes/read";
import { updateWebhook } from "./routes/update";
import { deleteWebhook } from "./routes/delete";
import { enableWebhook } from "./routes/enable";
import { disableWebhook } from "./routes/disable";
import { deliveryHistoryWebhook } from "./routes/deliveryHistory";

export const webhookRoutes = (service: $Webhooks, requests: $Requests) =>
	new Elysia({ normalize: false })
		.use(createWebhook(service, requests))
		.use(readWebhook(service, requests))
		.use(updateWebhook(service, requests))
		.use(deleteWebhook(service, requests))
		.use(enableWebhook(service, requests))
		.use(disableWebhook(service, requests))
		.use(deliveryHistoryWebhook(service, requests));
